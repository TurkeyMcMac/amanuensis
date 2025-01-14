import { Accordion, AccordionDetails, AccordionSummary, Box, Collapse, Grid, makeStyles, Popover, Typography } from '@material-ui/core'
import Tooltip from '@material-ui/core/Tooltip'
import { ArrowUpward, Build, Edit, Help, Info, LocalLibrary, School, Star, StarBorder, Search, Sort } from '@material-ui/icons'
import { resolve } from 'promise'
import React, { ReactElement } from 'react'
import { App, Section, Sections } from '../App'
import { uniq, ymd } from './util'

// the sorts of things that are children in React components
// probably there's some standard way to do this
type Child = string | React.ReactElement
export type Children = Child | Child[]

interface TTProps {
    children: ReactElement,
    msg: string,
    wrap?: boolean,
    placement?: "top-start" | "top" | "top-end" | "right-start" | "right" | "right-end" | "bottom-start" | "bottom" | "bottom-end" | "left-start" | "left" | "left-end"
}

// decorate an element with a tooltip
export function TT({ children, msg, placement, wrap }: TTProps): ReactElement {
    const child = wrap ? <span>{children}</span> : children
    if (placement) {
        return (
            <Tooltip title={msg} placement={placement} arrow>{child}</Tooltip>
        )
    } else {
        return (
            <Tooltip title={msg} arrow>{child}</Tooltip>
        )
    }
}

const detailsStyles = makeStyles((theme) => ({
    root: {
        marginBottom: '1rem'
    },
    header: {
        fontSize: theme.typography.pxToRem(16),
        fontWeight: theme.typography.fontWeightBold
    },
    details: {
        fontSize: theme.typography.pxToRem(14),
    }
}))

type DetailsProps = {
    children: Children
    header?: string
    expanded?: boolean
    onChange?: (event: object, expanded: boolean) => void
}

// a widget that displays the contents of a tab, a help button, and some expandable help text
export function Details({ children, header, ...accordionProps }: DetailsProps): ReactElement {
    const classes = detailsStyles()
    const headerElement = !header ? null :
        <Typography>
            <div className={classes.header}>{header}</div>
        </Typography>
    return (
        <div className={classes.root}>
            <Accordion {...accordionProps}>
                <AccordionSummary expandIcon={<Help />}>
                    {headerElement}
                </AccordionSummary>
                <AccordionDetails>
                    <Typography>
                        <div className={classes.details}>
                            {children}
                        </div>
                    </Typography>
                </AccordionDetails>
            </Accordion>
        </div>
    )
}

const starStyles = makeStyles((theme) => ({
    unstarred: {
        color: theme.palette.grey[500]
    },
    pointy: {
        cursor: 'pointer',
    }
}))

// for making a gold/grey-bordered star for bookmarks and such
export function Mark({ starred, onClick, fontSize, style }: { starred: boolean, style?: any, fontSize?: any, onClick?: () => void }) {
    const classes = starStyles()
    const cz = onClick ? (starred ? undefined : `${classes.unstarred} ${classes.pointy}`) : (starred ? undefined : classes.unstarred)
    const opts = { onClick, fontSize, style, className: cz }
    return starred ? <Star color="secondary" {...opts} /> : <StarBorder {...opts} />
}

const expandoStyles = makeStyles((theme) => ({
    root: {
        display: 'flex',
    },
    wrapper: {
        padding: theme.spacing(1)
    },
    item: {
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
        overflow: 'hidden',
        minWidth: 0,
        cursor: 'pointer',
    },
    closer: {
        float: 'right',
        cursor: 'pointer',
        fontWeight: 'bold',
        marginLeft: theme.spacing(1),
    }
}))

type ExpandoOpts = {
    text: Children,
    id: string,
    className?: string,
}

export function Expando({ text, id, className }: ExpandoOpts) {
    const classes = expandoStyles()
    const [anchorEl, setAnchorEl] = React.useState<null | Element>(null);
    const open = Boolean(anchorEl);
    const cz = className ? `${className} ${classes.root}` : classes.root
    return (
        <span className={cz}>
            <span className={classes.item} onClick={(event) => { setAnchorEl(event.currentTarget) }}>
                {text}
            </span>
            <Popover
                id={id}
                open={open}
                anchorEl={anchorEl}
                onClose={() => setAnchorEl(null)}
            >
                <div className={classes.wrapper}>
                    <span className={classes.closer} onClick={() => setAnchorEl(null)}>
                        &times;
                    </span>
                    {text}
                </div>
            </Popover>

        </span>
    )
}

// a general way to format a sequence of timestamps
export function formatDates(dates: Date[]): string | React.ReactElement {
    let ar = uniq(dates.map((d) => ymd(d) || '')).sort()
    const joined = ar.join(', ')
    if (ar.length > 3) {
        ar = [ar[0], '...', ar[ar.length - 1]]
        return <TT msg={joined}><span>{ar.join(' ')}</span></TT>
    }
    return joined
}

const titleboxStyles = makeStyles((theme) => ({
    box: {
        borderWidth: 1,
        borderColor: theme.palette.grey[500],
        borderRadius: theme.spacing(1),
        borderStyle: 'solid',
    },
    title: {
        position: 'relative',
        top: `-${theme.spacing(1.5)}px`,
        marginLeft: theme.spacing(1),
        backgroundColor: theme.palette.background.paper,
        fontWeight: 500,
        color: theme.palette.grey[500],
        paddingLeft: theme.spacing(1),
        paddingRight: theme.spacing(1),
    },
    inner: {
        padding: theme.spacing(2),
        paddingTop: 0,
    }
}))

type TitleBoxProps = {
    title: string
    children: Children
    m?: number
    mt?: number
    mb?: number
    ml?: number
    mr?: number
    style?: { [key: string]: any }
}

export function TitleBox(props: TitleBoxProps): ReactElement {
    const { title, children, ...boxProps } = props
    const classes = titleboxStyles()
    return (<Box className={classes.box} {...boxProps}>
        <span className={classes.title}>{title}</span>
        <div className={classes.inner}>{children}</div>
    </Box>)
}

type InfoProps = {
    flipped?: boolean
    setFlipped?: (flipped: boolean) => void
    fontSize?: 'inherit' | 'default' | 'large' | 'small' | 'tiny'
}

const infoSpinnerStyles = makeStyles((theme) => ({
    root: {
        cursor: 'pointer',
        color: theme.palette.grey[700],
    },
    tiny: {
        display: 'inline-table',
        textAlign: 'center',
        fontWeight: theme.typography.fontWeightBold,
    },
    flipped: {
        transform: 'rotate(180deg)',
        transition: 'transform 0.3s',
    },
    unflipped: {
        transform: 'rotate(0deg)',
        transition: 'transform 0.3s',
    }
}))

export function InfoSpinner({ flipped = false, setFlipped = (b: boolean) => { }, fontSize = 'small' }: InfoProps) {
    const classes = infoSpinnerStyles()
    const cz = `${classes.root} ${flipped ? classes.flipped : classes.unflipped}`
    if (fontSize === 'tiny') {
        return <span className={`${classes.tiny} ${classes.root}`} onClick={() => setFlipped(!flipped)}>
            <TT msg="info">
                <span>ⓘ</span>
            </TT>
        </span>
    } else {
        return <Help fontSize={fontSize} className={cz} onClick={() => setFlipped(!flipped)} />
    }
}

const infoBoxStyles = makeStyles((theme) => ({
    box: {
        padding: theme.spacing(1),
    }
}))

type InfoBoxProps = {
    children: Children
    shown: boolean
    m?: number
    mt?: number
    mb?: number
    ml?: number
    mr?: number
}

export function InfoBox(props: InfoBoxProps) {
    const { shown, children, ...boxProps } = props
    const classes = infoBoxStyles()
    return <Collapse in={shown}>
        <Box className={classes.box} {...boxProps}>
            {children}
        </Box>
    </Collapse>
}

// creates a smooth-scrolling link to the element elsewhere in the document with the given id
export function LinkDown({ to, id, children, className }: { to: string, children: Children, className?: string, id?: string }) {
    return <a href="#" id={id} className={className} onClick={(e) => {
        e.preventDefault()
        document.getElementById(to)?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
    }}>
        {children}
    </a>
}

// a LinkDown that looks for the table of contents
export function LinkUp() {
    return <LinkDown to="toc">
        <ArrowUpward fontSize="small" />
    </LinkDown>
}

// a link to another Amanuensis tab
export function TabLink({ tab, app, children }: { tab: Sections, app: App, children?: Children }) {
    let icon
    switch (tab) {
        case 'cards':
            icon = <School fontSize="small" />
            break
        case 'config':
            icon = <Build fontSize="small" />
            break
        case 'note':
            icon = <Edit fontSize="small" />
            break
        case 'projects':
            icon = <LocalLibrary fontSize="small" />
            break
        case 'search':
            icon = <Search fontSize="small" />
            break
        case 'sorters':
            icon = <Sort fontSize="small" />
            break
        default:
            throw new Error("we should never get here")
    }
    return (
        <a
            href="#"
            onClick={(e) => {
                e.preventDefault()
                app.setState({ tab: Section[tab] })
            }}
        >
            {children} {icon}
        </a>
    )
}

const aboutLinkStyles = makeStyles((theme) => ({
    root: {
        marginTop: theme.spacing(2),
        width: '100%',
    },
    link: {
        fontSize: 'smaller',
    }
}))

// generate the about link, which will pop up stuff like license information in a modal
export function AboutLink({ app }: { app: App }) {
    const classes = aboutLinkStyles()
    const onClick = (e: any) => {
        e.preventDefault()
        app.confirm({
            title: "About Amanuensis",
            alert: true,
            callback: () => new Promise((resolve, _reject) => resolve(undefined)),
            text: <>
                More to come.
                <a href="#" onClick={linkClick("https://github.com/dfhoughton/amanuensis#readme")}>Repository</a>
            </>
        })
    }
    const linkClick = (url: string) => (e: any) => {
        e.preventDefault()
        app.load(url)
    }
    return (
        <Grid container direction="row" justify="flex-end" className={classes.root}>
            <Grid item>
                <a href="#" className={classes.link} onClick={onClick}>about</a>
            </Grid>
        </Grid>
    )
}