import { deepClone } from './clone'
import { Chrome, KeyPair, NoteRecord, ProjectInfo, ProjectIdentifier, Normalizer, Query, CitationRecord } from './types'

// utility function to convert maps into arrays for permanent storage
function m2a(map: Map<any, any>): [any, any][] {
    const ar: [any, any][] = []
    map.forEach((v, k) => ar.push([k, v]))
    return ar
}

type Match = [project: number, record: NoteRecord]

type FindResponse =
    { state: "found", match: Match } |
    { state: "ambiguous", matches: Match[] } |
    { state: "none" }

// an interface between the app and the Chrome storage mechanism
export class Index {
    chrome: Chrome                                   // the chrome API
    projects: Map<string, ProjectInfo>               // an index from project names to ProjectInfo records
    currentProject: number                           // the primary key of the project the user set as the default (as opposed to the catch-all default project)
    projectIndices: Map<number, Map<string, number>> // an index from project primary keys to indices from phrases normalized by the respective project's normalizer to that phrase's primary key for the project
    tags: Set<string>                                // the set of all tags used in a phrase in any project
    reverseProjectIndex: Map<number, string>         // an index from ProjectInfo primary keys to names
    cache: Map<string, NoteRecord>                   // a mechanism to avoid unnecessary calls to fetch things from chrome storage
    constructor(chrome: Chrome, projects: Map<string, ProjectInfo>, currentProject: number, projectIndices: Map<number, Map<string, number>>, tags: Set<string>) {
        this.chrome = chrome
        this.projects = projects
        this.currentProject = currentProject
        this.projectIndices = projectIndices
        this.tags = tags
        if (this.projectIndices.size === 0) {
            // add the default project
            const project = this.makeDefaultProject()
            this.projects.set(project.name, project)
            this.projectIndices.set(project.pk, new Map())
            const storable = { projects: m2a(this.projects) }
            this.chrome.storage.local.set(storable)
        }
        this.reverseProjectIndex = new Map()
        this.projects.forEach((value, key) => this.reverseProjectIndex.set(value.pk, key))
        this.cache = new Map()
    }

    makeDefaultProject(): ProjectInfo {
        return {
            pk: 0,
            name: '',
            description: 'A project for notes that have no project.',
            normalizer: '',
            relations: [["see also", "see also"]]
        }
    }

    // return the set of relations known to the project
    relationsForProject(project: ProjectIdentifier): Set<string> {
        const [, projectInfo]: [string, ProjectInfo] = this.findProject(project)
        const relations: Set<string> = new Set()
        for (const pair in projectInfo.relations) {
            relations.add(pair[0])
            relations.add(pair[1])
        }
        return relations
    }

    // returns the other relation in a relation pair, e.g., "part" for "whole", "subtype" for "supertype", or "synonym" for "synonym"
    // the last is an example of a symmetric relation; the "see also" relation, the only relation available by default, is symmetric
    reverseRelation(project: ProjectIdentifier, relation: string): string | null {
        const [, projectInfo] = this.findProject(project)
        for (const pair in projectInfo.relations) {
            if (pair[0] === relation) {
                return pair[1]
            }
            if (pair[1] === relation) {
                return pair[0]
            }
        }
        return null
    }

    // returns the subset of the keypairs which are now missing from storage
    missing(maybeMissing: Set<KeyPair>): Promise<Set<KeyPair>> { // TODO fix this -- sets can't have structs as members
        // first get rid of the things in the cache
        const pairs = Array.from(maybeMissing).filter(([proj, note]) => !this.cache.has(`${proj}:${note}`))
        return new Promise((resolve, reject) => {
            if (pairs.length) {
                const missing = new Set(pairs)
                const map = new Map(pairs.map(([v1, v2]) => [`${v1}:${v2}`, [v1, v2]]))
                const keys = Array.from(map.keys())
                this.chrome.storage.local.get(keys, (found) => {
                    if (this.chrome.runtime.lastError) {
                        reject(this.chrome.runtime.lastError)
                    } else {
                        for (const key of Object.keys(found)) {
                            const p = map.get(key)
                            if (p) {
                                missing.delete(p as KeyPair)
                            }
                        }
                        resolve(missing)
                    }
                })
            } else {
                resolve(new Set())
            }
        })
    }

    // looks in given project for phrase, resolving it in promise as {project, found}
    // if no project is given and the phrase exists only in one project, also provides {project, found}
    // if no project is given and the phrase exists in multiple projects, provides [project...]
    find(query: Query): Promise<FindResponse> {
        switch (query.type) {
            case "lookup":
                const { phrase, project } = query
                const projects = project == null ? this.allProjects() : [project]
                return new Promise((resolve, reject) => {
                    const keys: [project: number, note: number][] = []
                    for (const pk of projects) {
                        const i = this.projectIndex(phrase, pk)
                        if (i != null) {
                            keys.push([pk, i])
                        }
                    }
                    if (keys.length) {
                        const stringKeys = keys.map(([p, n]) => `${p}:${n}`)
                        const rv: Match[] = []
                        const continuation = () => {
                            if (rv.length > 1) {
                                resolve({ state: "ambiguous", matches: rv })
                            } else {
                                resolve({ state: "found", match: rv[0] })
                            }
                        }
                        // first search the cache
                        for (let i = keys.length - 1; i >= 0; i--) {
                            const key = stringKeys[i]
                            const note = this.cache.get(key)
                            if (note != null) {
                                rv.push([keys[i][0], note])
                                keys.splice(i, 1)
                                stringKeys.splice(i, 1)
                            }
                        }
                        if (keys.length) {
                            // we have to get some out of storage as well
                            this.chrome.storage.local.get(stringKeys, (found) => {
                                if (this.chrome.runtime.lastError) {
                                    reject(this.chrome.runtime.lastError)
                                } else {
                                    for (let i = 0; i < keys.length; i++) {
                                        const key = stringKeys[i]
                                        const note = found[key]
                                        this.cache.set(key, deepClone(note)) // cache it so we don't have to look it up next time
                                        rv.push([keys[i][0], note])
                                    }
                                    continuation()
                                }
                            })
                        } else {
                            continuation()
                        }
                    } else {
                        resolve({ state: "none" })
                    }
                })
            case "ad hoc":
                const requirements: { [key: string]: any } = query
                delete requirements.type
                return new Promise((resolve, reject) => {
                    if (Object.keys(requirements)) {
                        if (!query.project) {
                            query.project = this.allProjects()
                        }
                        let normalized: Map<number, string> | undefined
                        let fuzzyMatchers: Map<number, RegExp> | undefined
                        if (query.phrase != null) {
                            normalized = new Map()
                            if (query.strictness == null || query.strictness === "fuzzy") {
                                fuzzyMatchers = new Map()
                            }
                            for (const pk of query.project) {
                                const key = this.normalize(query.phrase, pk)
                                normalized.set(pk, key)
                                fuzzyMatchers?.set(
                                    pk,
                                    new RegExp(
                                        key.split('').map((c) => c.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join(".*?")
                                    )
                                )
                            }
                        }
                        let candidates: Match[] = []
                        const continuation = () => { // what to do once we've got our matches
                            const any = (ar: any[], f: (arg: any) => boolean): boolean => {
                                for (const o of ar) {
                                    if (f(o)) {
                                        return true
                                    }
                                }
                                return false
                            }
                            const all = (ar: any[], f: (arg: any) => boolean): boolean => {
                                for (const o of ar) {
                                    if (!f(o)) {
                                        return false
                                    }
                                }
                                return true
                            }
                            candidates = candidates.filter(([, note]) => {
                                // phrase/strictness filtering is necessarily already done at this point
                                // progress from easy to hard
                                const { starred, url, tagRequired, tagForbidden, before, after } = query
                                if (starred != null) {
                                    if (starred) {
                                        if (!note.starred) {
                                            return false
                                        }
                                    } else {
                                        if (note.starred) {
                                            return false
                                        }
                                    }
                                    if (tagRequired?.length) {
                                        if (any(tagRequired, (t) => note.tags.indexOf(t) === -1)) {
                                            return false
                                        }
                                    }
                                    if (tagForbidden?.length) {
                                        if (any(tagForbidden, (t) => note.tags.indexOf(t) > -1)) {
                                            return false
                                        }
                                    }
                                    if (url != null) {
                                        if (all(note.citations, (c) => c.source.url.indexOf(url) === -1)) {
                                            return false
                                        }
                                    }
                                    if (before != null) {
                                        if (all(note.citations, (c) => all(c.when, (w) => w > before))) {
                                            return false
                                        }
                                    }
                                    if (after != null) {
                                        if (all(note.citations, (c) => all(c.when, (w) => w < after))) {
                                            return false
                                        }
                                    }
                                    return true
                                }
                            })
                            if (candidates.length) {
                                if (candidates.length === 1) {
                                    resolve({ state: "found", match: candidates[0] })
                                } else {
                                    resolve({ state: "ambiguous", matches: candidates })
                                }
                            } else {
                                resolve({ state: "none" })
                            }
                        }
                        const toLookUp: string[] = []
                        if (query.phrase != null && query.strictness === "exact") {
                            // we don't have to iterate over all keys!!
                            for (let [pk, key] of normalized || []) {
                                const i = this.projectIndices.get(pk)!.get(key)
                                if (i != null) {
                                    key = `${pk}:${i}`
                                    const note = this.cache.get(key)
                                    if (note) {
                                        candidates.push([pk, note])
                                    } else {
                                        toLookUp.push(key)
                                    }
                                }
                            }
                        } else {
                            for (const pk of query.project) {
                                const index: Map<string, number> = this.projectIndices.get(pk) || new Map()
                                for (const [normed, i] of index.entries()) {
                                    if (query.phrase) {
                                        if (query.strictness === "substring") {
                                            const norm = normalized!.get(pk)
                                            if (norm) {
                                                if (normed.indexOf(norm) == -1) {
                                                    continue
                                                }
                                            }
                                        } else {
                                            if (!fuzzyMatchers?.get(pk)?.test(normed)) {
                                                continue
                                            }
                                        }
                                    }
                                    const key = `${pk}:${i}`
                                    const note = this.cache.get(key)
                                    if (note) {
                                        candidates.push([pk, note])
                                    } else {
                                        toLookUp.push(key)
                                    }
                                }
                            }
                        }
                        if (toLookUp.length) {
                            this.chrome.storage.local.get(toLookUp, (found) => {
                                if (this.chrome.runtime.lastError) {
                                    reject(this.chrome.runtime.lastError)
                                } else {
                                    for (const [key, note] of Object.entries(found)) {
                                        const pk: number = Number.parseInt(key.split(":")[0])
                                        candidates.push([pk, note as NoteRecord])
                                    }
                                    continuation()
                                }
                            })
                        } else {
                            continuation()
                        }
                    } else {
                        // no filters means no results 
                        resolve({ state: "none" })
                    }
                })
        }
    }

    allProjects(): number[] {
        return Array.from(this.projectIndices.keys())
    }

    // save a phrase, all the data associated with the phrase should be packed into data
    add({ phrase, project, data }: { phrase: string, project: number, data: NoteRecord }): Promise<void> {
        return new Promise((resolve, reject) => {
            const storable: { [key: string]: any } = {}
            const [, projectInfo] = this.findProject(project)
            const key = this.normalize(phrase, projectInfo)
            let projectIndex = this.projectIndices.get(projectInfo.pk) || new Map()
            let pk = projectIndex.get(key)
            if (pk == null) {
                // this is necessarily in neither the index nor the project index
                // we will have to generate a primary key for this phrase and store both indices
                pk = 0
                projectIndex.forEach(function (v, k) {
                    if (v >= pk) {
                        pk = v + 1
                    }
                })
                projectIndex.set(key, pk)
                storable[projectInfo.pk.toString()] = m2a(projectIndex)
            }
            const keyPair: KeyPair = [projectInfo.pk, pk] // convert key to the 
            this.cache.set(`${keyPair[0]}:${keyPair[1]}`, data)
            // check for any new tags
            const l = this.tags.size
            for (const tag of data.tags) {
                this.tags.add(tag)
            }
            if (this.tags.size > l) {
                const tags: string[] = []
                for (const tag of this.tags) {
                    tags.push(tag)
                }
                storable.tags = tags
            }
            // modify any phrases newly tied to this by a relation
            // NOTE any relation *deleted* in editing will need to be handled separately
            for (const [relation, pairs] of Object.entries(data.relations)) {
                let reversedRelation: string = ''
                for (const pair of pairs) {
                    const other = this.cache.get(`${pair[0]}:${pair[1]}`)
                    if (other) {
                        // other will necessarily be cached if a relation to it was added
                        reversedRelation ||= this.reverseRelation(projectInfo, relation) || ''
                        outer: for (const [relation2, pairs2] of Object.entries(other.relations)) {
                            if (relation2 === reversedRelation) {
                                for (const key2 of pairs2) {
                                    if (key2[0] === keyPair[0] && key2[1] === keyPair[1]) {
                                        break outer
                                    }
                                }
                                // this is a new relation for other, so we'll need to store other
                                pairs2.push(keyPair)
                                storable[`${pair[0]}:${pair[1]}`] = other
                                break // we found the reversed relation, so we're done with this pair/relation
                            }
                        }
                    }
                }
            }
            // store the phrase itself
            storable[`${keyPair[0]}:${keyPair[1]}`] = data
            this.chrome.storage.local.set(storable, () => {
                if (this.chrome.runtime.lastError) {
                    reject(this.chrome.runtime.lastError)
                } else {
                    resolve()
                }
            })
        })
    }

    delete({ phrase, project }: { phrase: string, project: ProjectInfo }): Promise<void> {
        return new Promise((resolve, reject) => {
            // TODO
            // must delete given phrase from the given project
            // must delete it from the project index
            // must delete it from all the phrases to which it is related
            // then must also iterate over *all* the phrases in the project to see if any share its default normalization
            // if so, the master index need not be altered and saved
            // otherwise, we must delete its entry from the master index as well
        })
    }

    // delete a particular relation between two phrases
    // these two phrases will necessarily both already be saved
    deleteRelation({ phrase, project, relation, pair }: { phrase: string, project: ProjectInfo, relation: string, pair: KeyPair }): Promise<void> {
        return new Promise((resolve, reject) => {
            const [projectName, projectInfo] = this.findProject(project)
            let key = this.normalize(phrase, projectInfo)
            const projectIndex = this.projectIndices.get(projectInfo.pk)
            let pk = projectIndex?.get(key)
            if (pk == null) {
                reject(`the phrase ${phrase} is not stored in ${projectName}`)
            } else {
                const data = this.cache.get(`${projectInfo.pk}:${pk}`) // the phrase in question is necessarily cached
                if (data) {
                    const continuation = (other: NoteRecord) => {
                        // prepare other end of relation for storage
                        const reversedRelation = this.reverseRelation(projectInfo, relation)
                        if (reversedRelation) {
                            const storable: { [key: string]: any } = {}
                            storable[`${pair[0]}:${pair[1]}`] = other
                            // remove other end of relation from other's relations
                            let pairs2 = other.relations[reversedRelation] || []
                            const pairs22: KeyPair[] = []
                            for (const [r2, pk2] of pairs2) {
                                if (!(r2 === projectInfo.pk && pk2 === pk)) {
                                    pairs22.push([r2, pk2])
                                }
                            }
                            if (pairs22.length) {
                                other.relations[reversedRelation] = pairs22
                            } else {
                                delete other.relations[reversedRelation]
                            }
                            // remove near end of relation from data's relations
                            const data2 = deepClone(data) // don't modify the original so React can use if for diffing
                            storable[`${key[0]}:${key[1]}`] = data2
                            let pairs: KeyPair[] = data2.relations[relation] || []
                            pairs2 = []
                            for (const [r2, pk2] of pairs) {
                                if (!(r2 === pair[0] && pk2 === pair[1])) {
                                    pairs2.push([r2, pk2])
                                }
                            }
                            if (pairs2.length) {
                                data2.relations[relation] = pairs2
                            } else {
                                delete data2.relations[relation]
                            }
                            this.chrome.storage.local.set(storable, () => {
                                if (this.chrome.runtime.lastError) {
                                    reject(this.chrome.runtime.lastError)
                                } else {
                                    resolve()
                                }
                            })
                        } else {
                            reject(`could not find the reversed relation for ${relation} in ${projectName}`)
                        }
                    }
                    const otherKey = `${pair[0]}:${pair[1]}`
                    const other = this.cache.get(otherKey)
                    if (other) {
                        continuation(other)
                    } else {
                        this.chrome.storage.local.get([`${pair[0]}:${pair[1]}`], (found) => {
                            if (this.chrome.runtime.lastError) {
                                reject(this.chrome.runtime.lastError)
                            } else {
                                this.cache.set(otherKey, found)
                                continuation(found)
                            }
                        })
                    }
                } else {
                    reject("the phrase was not cached; this should be unreachable code")
                }
            }
        })
    }

    // how much memory do we have left?
    // useful for warning the user
    // success value of promise will be the number of bytes remaining
    memfree(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.chrome.storage.local.getBytesInUse(null, (bytes: number) => {
                if (this.chrome.runtime.lastError) {
                    reject(this.chrome.runtime.lastError)
                } else {
                    resolve(5242880 - bytes)
                }
            })
        })
    }
    // convert a project in any representation, name, index, or info, into a [name, info] pair
    findProject(project: string | number | ProjectInfo): [string, ProjectInfo] {
        let projectInfo: ProjectInfo
        switch (typeof project) {
            case 'number':
                const r = this.reverseProjectIndex.get(project)
                if (r) {
                    project = r
                    const ri = this.projects.get(project)
                    if (ri) {
                        return [r, ri]
                    } else {
                        return this.defaultProject()
                    }
                } else {
                    return this.defaultProject()
                }
            case 'string':
                const ri = this.projects.get(project)
                if (ri) {
                    return [project.toString(), ri]
                } else {
                    return this.defaultProject()
                }
            case 'object':
                if (project) {
                    projectInfo = project
                    const r = this.reverseProjectIndex.get(project.pk)
                    if (r) {
                        return [r, projectInfo]
                    } else {
                        return this.defaultProject()
                    }
                } else {
                    return this.defaultProject()
                }
            default:
                throw new Error("unreachable")
        }
    }
    defaultProject(): [string, ProjectInfo] {
        return ['', this.projects.get('') as ProjectInfo]
    }
    setCurrentProject(pk: number): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.reverseProjectIndex.get(pk) != null) {
                this.chrome.storage.local.set({ currentProject: pk }, () => {
                    if (this.chrome.runtime.lastError) {
                        reject(this.chrome.runtime.lastError)
                    } else {
                        this.currentProject = pk
                        resolve()
                    }
                })
            } else {
                reject(`${pk} is not the primary key of a known project`)
            }
        })
    }
    // save a project or create a new one
    // the optional callback receives an error message, if any
    saveProject({
        name,
        description = '[no description]',
        normalizer = '',
        relations = [["see also", "see also"]],
    }: ProjectInfo): Promise<number> {
        return new Promise((resolve, reject) => {
            // whitespace normalization
            // TODO detect normalizer changes AND RENORMALIZE AND RE-INSERT EVERYTHING!!!
            name = name.replace(/^\s+|\s+$/g, '').replace(/\s+/, ' ')
            description = description.replace(/^\s+|\s+$/g, '').replace(/\s+/, ' ')
            let pk: number
            const storable: { [key: string]: any } = {}
            if (this.projects.has(name)) {
                pk = (this.projects.get(name) as ProjectInfo).pk
            } else {
                pk = 1
                for (const [, projectInfo] of this.projects) {
                    if (projectInfo.pk >= pk) {
                        pk = projectInfo.pk + 1
                    }
                }
                this.projectIndices.set(pk, new Map())
                this.reverseProjectIndex.set(pk, name)
                storable[pk.toString()] = []
            }
            const project: ProjectInfo = { pk, name, description, normalizer, relations }
            this.projects.set(name, project)
            storable.projects = m2a(this.projects)
            this.chrome.storage.local.set(storable, () => {
                if (this.chrome.runtime.lastError) {
                    reject(this.chrome.runtime.lastError)
                } else {
                    resolve(pk)
                }
            })
        })
    }
    removeProject(project: ProjectIdentifier): Promise<void> {
        return new Promise((resolve, reject) => {
            const [, projectInfo] = this.findProject(project)
            const delenda: string[] = []
            const memoranda: { [name: string]: any } = {}
            const notes: NoteRecord[] = []
            const missing: string[] = []
            const found: string[] = []
            for (const pk of this.projectIndices.get(projectInfo.pk)!.values()) {
                const key = `${projectInfo.pk}:${pk}`
                const note = this.cache.get(key)
                if (note) {
                    notes.push(note)
                    found.push(key)
                } else {
                    missing.push(key)
                }
                delenda.push(key)
            }
            // continuation that handles notes in other projects that need adjustment
            const continuation1 = () => {
                const adjustanda: string[] = []
                const adjustables: [key: string, note: NoteRecord][] = []
                // continuation that takes the adjustables and adjusts them
                const continuation2 = () => {
                    for (const [key, note] of adjustables) {
                        const keepers = note.relations["see also"].filter(([k, v]) => k !== projectInfo.pk)
                        if (keepers.length) {
                            note.relations["see also"] = keepers
                        } else {
                            delete note.relations["see also"]
                        }
                        memoranda[key] = note
                    }
                    delenda.push(projectInfo.pk.toString())
                    // now we've queued up everything that needs deletion and almost everything that needs to be saved with changes
                    this.chrome.storage.local.remove(delenda, () => {
                        if (this.chrome.runtime.lastError) {
                            reject(this.chrome.runtime.lastError)
                        } else {
                            this.projects.delete(projectInfo.name)
                            this.reverseProjectIndex.delete(projectInfo.pk)
                            if (this.currentProject === projectInfo.pk) {
                                this.currentProject = 0
                                memoranda.currentProject = 0
                            }
                            memoranda.projects = m2a(this.projects)
                            // now we need to save the changes
                            this.chrome.storage.local.set(memoranda, () => {
                                if (this.chrome.runtime.lastError) {
                                    reject(`all the notes in ${projectInfo.name} have been deleted, but some changes could not be saved: ${this.chrome.runtime.lastError}`)
                                } else {
                                    for (const key of found) {
                                        this.cache.delete(key)
                                    }
                                    resolve()
                                }
                            })
                        }
                    })
                }
                for (const note of notes) {
                    for (const [k, v] of (note.relations["see also"] || []).filter(([k, v]) => k !== projectInfo.pk)) {
                        const key = `${k}:${v}`
                        const adjustable = this.cache.get(key)
                        if (adjustable) {
                            adjustables.push([key, adjustable])
                        } else {
                            adjustanda.push(key)
                        }
                    }
                }
                if (adjustanda.length) {
                    this.chrome.storage.local.get(adjustanda, (found) => {
                        if (this.chrome.runtime.lastError) {
                            reject(this.chrome.runtime.lastError)
                        } else {
                            for (const [key, note] of Object.entries(found)) {
                                adjustables.push([key, note as NoteRecord])
                            }
                            continuation2()
                        }
                    })
                } else {
                    continuation2()
                }
            }
            if (missing.length) {
                this.chrome.storage.local.get(missing, (found) => {
                    if (this.chrome.runtime.lastError) {
                        reject(this.chrome.runtime.lastError)
                    } else {
                        for (const note of Object.values(found)) {
                            notes.push(note as NoteRecord)
                        }
                        continuation1()
                    }
                })
            } else {
                continuation1()
            }
        })
    }
    // create the key a phrase should be stored under for a given project
    key(phrase: string, project: ProjectIdentifier): string | null {
        const [, projectInfo] = this.findProject(project)
        const index = this.projectIndex(phrase, projectInfo)
        if (index != null) {
            return `${projectInfo.pk}:${index}`
        }
        return null
    }
    // return the pk, if any, of a phrase within a project
    projectIndex(phrase: string, project: ProjectIdentifier): number | null {
        const [, projectInfo] = this.findProject(project)
        const idx = this.projectIndices.get(projectInfo.pk) as Map<string, number>
        const i = idx.get(this.normalize(phrase, projectInfo))
        if (i == null) {
            return null
        } else {
            return i
        }
    }
    // normalize phrase for use in retrieval and insertion
    normalize(phrase: string, project: ProjectIdentifier): string {
        let r: ProjectInfo
        if (typeof project === 'object') {
            r = project
        } else {
            [project, r] = this.findProject(project)
        }
        const normalizer = r ? r.normalizer : ""
        return normalizers[normalizer || ""].code(phrase)
    }
    defaultNormalize(phrase: string): string {
        return normalizers[""].code(phrase)
    }
    // clears *everything* from local storage; if promise fails error message is provided
    clear(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.chrome.storage.local.clear(() => {
                if (this.chrome.runtime.lastError) {
                    reject(this.chrome.runtime.lastError)
                } else {
                    this.cache.clear()
                    this.projectIndices.clear()
                    this.projects.clear()
                    this.reverseProjectIndex.clear()
                    this.tags.clear()
                    // restore the default project
                    const project = this.makeDefaultProject()
                    this.projects.set(project.name, project)
                    this.projectIndices.set(project.pk, new Map())
                    const storable = { projects: m2a(this.projects) }
                    this.chrome.storage.local.set(storable) // if this fails no harm done
                    resolve()
                }
            })
        })
    }
}

// get an API to handle all storage needs
export function getIndex(chrome: Chrome): Promise<Index> {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(['projects', 'currentProject', 'tags'], (result) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError)
            } else {
                let { projects = [], currentProject = 0, tags = [] } = result || {}
                // now that we have the project we can fetch the project indices
                const indices: string[] = []
                for (const [, projectInfo] of projects) {
                    indices.push(projectInfo.pk.toString())
                }
                chrome.storage.local.get(indices, (result: { [projectPk: string]: [phrase: string, pk: number][] }) => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError)
                    } else {
                        const projectIndices = new Map()
                        for (const [idx, ridx] of Object.entries(result)) {
                            projectIndices.set(Number.parseInt(idx), new Map(ridx))
                        }
                        resolve(new Index(chrome, new Map(projects), currentProject, projectIndices, new Set(tags)))
                    }
                })
            }
        })
    })
}

function stripDiacrics(s: string): string {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, "")
}

// a collection of string normalization functions with metadata for use in display
export const normalizers: { [key: string]: Normalizer } = {
    "": {
        pk: 0,
        name: 'default', // by default the name of a normalizer will be its key
        description: `
            Strips marginal whitespace, replaces any internal spaces with a singe whitespace,
            strips diacritics, removes non-word ( a-z, 0-9, and _) characters, converts to lowercase.
        `,
        code: function (phrase) {
            return stripDiacrics(phrase.replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ')).replace(/[^\p{L}\p{N} _'-]+/ug, '').toLowerCase()
        }
    },
    "German": {
        pk: 1,
        name: 'German',
        description: `
            Identical to the default normalizer but it also converts ß, ä, ö, and ü to ss, ae, oe, and ue, respectively.
        `,
        code: function (phrase) {
            phrase = phrase.replace(/^\s+|\s+$/g, '')
                .replace(/\s+/g, ' ')
                .toLocaleLowerCase()
                .replace(/ß/g, 'ss')
                .replace(/ä/g, 'ae')
                .replace(/ö/g, 'oe')
                .replace(/ü/g, 'ue')
            return stripDiacrics(phrase).replace(/[^\p{L}\p{N} _'-]+/ug, '')
        }
    },
}