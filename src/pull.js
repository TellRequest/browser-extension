'use strict';

import { GithubApi, PullRequestPage } from './github.js';
import { MAGIC, Opt, Promises, Try, Util, Element } from './common.js';
import { Comment, File, FileContext, Ids, Presentation } from './model/model.js';
import { CommentUI, DividerUI, SettingsUI, SidebarUI } from './ui/ui.js';
import { l10n } from './l10n.js';
import { getConfig } from './config.js';

const parseComment = c => {
    const PARSE_REGEX = new RegExp(`^(?<before>.*?)(?:<!--\\s*)?(?:${MAGIC})(?<data>.*)(?:${MAGIC})(?:\\s*-->)?(?<after>.*)$`, 'gs');
    let { value: matches } = c.matchAll(PARSE_REGEX)?.next();
    if (!matches)
        return;

    const body = matches.groups.data;
    const rest = matches.groups.before + matches.groups.after;
    const j = Try(() => JSON.parse(body));
    if (!j) return;
    return {
        data: j,
        comment: rest
    };
};

const renderComment = c => {
    return c.comment + ((!c.comment.length || /\s$/.test(c.comment)) ? '' : '\n') + '<!-- ' + MAGIC + JSON.stringify(c.data, null, 2) + MAGIC + ' -->';
};

class App {
    constructor({ github, prPage }) {
        this.github = github;
        this.prPage = prPage;
        this.events = Util.createEventTarget();
        this.presentation = new Presentation();
        this.presentation.events.addEventListener('change', e => this.onPresentationChange(e));
        this.presentation.events.addEventListener('change', e => this.maybePersistOnPresentationChange(e));

        this.files = [];

        this.events.addEventListener('select', e => this.onSelect(e));
    }

    async init(document) {
        const sidebar = this.sidebar = new SidebarUI();
        document.querySelector('[data-target="diff-layout.mainContainer"].Layout-main').after(sidebar.rootElem);

        const divider = this.divider = new DividerUI();
        divider.events.addEventListener('resize', e => this.onDividerResize(e));
        divider.events.addEventListener('collapse', e => this.onDividerCollapse(e));
        sidebar.rootElem.before(divider.rootElem);

        sidebar.events.addEventListener('navTo', e => this.onSidebarNav(e));
        sidebar.events.addEventListener('delete', e => this.onSidebarDelete(e));
        sidebar.events.addEventListener('reorder', e => this.onSidebarReorder(e));

        const settings = this.settings = new SettingsUI();
        settings.events.addEventListener('load', e => this.onSettingsLoad(e));
        settings.events.addEventListener('save', e => this.onSettingsSave(e));
        document.querySelector('.diffbar > :last-child').before(settings.rootElem);

        this.initAddVisualButtons();

        if (await getConfig('openFrequency') === 'auto') {
            await this.onSettingsLoad();
        }
    }

    async import(data) {
        // this.sidebar.reset();
        // this.divider.reset();
        // this.settings.reset();

        if (this.presentation.length) {
            const cleanupDone = Util.waitEvent(this.presentation.events, 'change');
            this.presentation.removeAllVisuals();
            await cleanupDone;
        }

        const getAllIds = (o) => {
            if (o?.id) return o?.id;
            return Object.values(o).flatMap(v => {
                if (Array.isArray(v))
                    return v.flatMap(getAllIds);
                if (typeof (v) === 'object')
                    return getAllIds(v);
                return [];
            });
        };

        const maxId = getAllIds(data).map(x => parseInt(x)).toArray().sort((a, b) => b - a).first() || 1;
        Ids.initId(maxId);

        const presentation = new Presentation();
        presentation.events.addEventListener('change', e => this.onPresentationChange(e));
        presentation.import(data);
        presentation.events.addEventListener('change', e => this.maybePersistOnPresentationChange(e));
        this.presentation = presentation;
    }

    export() {
        return this.presentation.export();
    }

    async persist() {
        const currentValue = (await this.github.issue.fetchIssueEditForm(this.prPage.getPullId())).editForm.querySelector('textarea').value;
        const currentParsed = parseComment(currentValue) || { comment: currentValue, data: {} };
        currentParsed.data = this.export();
        await this.github.issue.updateIssuePart({ part: 'body', text: renderComment(currentParsed) });
    }

    createCommentUI({ fileElem, value }) {
        const commentUI = new CommentUI({ github: this.github, prPage: this.prPage, fileElem, value });
        commentUI.events.addEventListener('accept', async e => {
            const { comment } = e.detail;
            this.presentation.addOrReplaceVisual({ visual: comment });
        });

        commentUI.rootElem.addEventListener('focusin', _ => {
            this.selectVisual(value.id);
        });
        commentUI.rootElem.addEventListener('click', _ => {
            this.selectVisual(value.id);
        });
        return commentUI;
    }

    initAddVisualButtons() {

        const createButton = ({ file, fileElem, originalButton }) => {
            const lineNo = originalButton.ancestors('td').first().previousElementSibling.getAttribute('data-line-number');
            const context = new FileContext({ file, lineNo });

            const addButton = document.createElement('button');
            addButton.classList.add('add-line-comment');
            addButton.classList.add('btn-link');
            addButton.innerHTML = originalButton.innerHTML;
            addButton.style.backgroundColor = 'red';
            addButton.style.left = '20px';
            originalButton.parentElement.prepend(addButton)

            addButton.addEventListener('click', async e => {
                const commentUI = this.createCommentUI({ fileElem, value: new Comment({ context }) });

                originalButton.ancestors().filter(x => x.tagName === 'TR').first()
                    .after(commentUI.rootElem);
                commentUI.writeButton.click();
            });
            return addButton;
        };

        const fileElems = document.querySelectorAll('div[data-tagsearch-path].file');
        fileElems.forEach(fileElem => {
            const file = new File(fileElem.getAttribute('data-tagsearch-path'));
            fileElem.querySelectorAll('button.add-line-comment')
                .forEach(originalButton => createButton({ file, fileElem, originalButton }));
        });
    }

    findVisualUI(id) {
        return document.querySelector(`[data-visual-id="${id}"].visual-root`)?.data.visualUI;
    }

    async onPresentationChange(e) {
        const { presentation, added, removed } = e.detail;
        removed.forEach(x => this.sidebar.remove(x.id));
        removed.forEach(x => document.querySelector(`[data-visual-id="${x.id}"].visual-root`)?.remove());

        added.forEach(x => this.sidebar.add(x, presentation.indexOf({ id: x.id })));
        added.forEach(x => {
            const existingUI = this.findVisualUI(x.id);
            if (existingUI) {
                existingUI.setText(x.text);
            } else {
                const tr = document.querySelector(`div.file .diff-table tr:has(td[data-line-number="${x.context.lineNo}"])`);
                const fileElem = tr.ancestors().find(x => x.classList.contains('file')).first();
                const commentUI = this.createCommentUI({ fileElem, value: x })
                tr.after(commentUI.rootElem);
                commentUI.setPreviewTab(); // no need to await
            }
        });
    }

    async maybePersistOnPresentationChange(e) {
        if (await getConfig('saveFrequency') === 'auto')
            await this.persist();
    }

    onSidebarNav(e) {
        const { id } = e.detail;
        this.findVisualUI(id).rootElem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.selectVisual(id);
    }

    onSidebarDelete(e) {
        const { id } = e.detail;
        this.presentation.removeVisual({ id });
    }

    async onSidebarReorder(e) {
        const { id, newPosition } = e.detail;
        this.presentation.moveVisual({ id, position: newPosition });
        this.sidebar.move(id, newPosition);
    }

    onSelect(e) {
        const { id } = e.detail;
        this.sidebar.select(id);
    }

    selectVisual(id) {
        if (this.findVisualUI(id).rootElem.classList.contains('selected')) return;
        document.querySelectorAll(`.${MAGIC}.visual-root.selected`).forEach(x => x.classList.remove('selected'));
        this.findVisualUI(id)?.rootElem.classList.add('selected');
        this.events.dispatchEvent(new CustomEvent('select', { detail: { id } }));
    }

    onDividerResize(e) {
        const { pageX } = e.detail;
        this.sidebar.rootElem.style.width = `${this.sidebar.rootElem.getBoundingClientRect().right - pageX}px`;
    }

    onDividerCollapse(e) {
        const { collapsed } = e.detail;
        this.sidebar.rootElem.classList.toggle('collapsed', collapsed);
    }

    async onSettingsSave(e) {
        await this.persist();
    }

    async onSettingsLoad(e) {
        const issueForm = await this.github.issue.fetchIssueEditForm(this.prPage.getPullId());
        const currentValue = issueForm.editForm.querySelector('textarea').value;
        const parsed = parseComment(currentValue);
        this.import(parsed.data);
    }
}

let app;

const onDocumentLoad = async _ => {
    l10n.setLocale(await getConfig('language'));

    {
        const prPage = new PullRequestPage();
        const {
            owner, repository, pull
        } = prPage.parseUrl();
        const github = new GithubApi({
            repositoryUrl: `/${owner}/${repository}`,
            pullUrl: `/${owner}/${repository}/pull/${pull}`,
        });
        app = new App({ document, github, prPage });
        await app.init(document);
    }

    (() => {
        const debug = document.createElement('button');
        debug.innerHTML = 'Debug';
        debug.addEventListener('click', e => {
            const exported = JSON.stringify(app.export());
            navigator.clipboard.writeText(exported);
            console.log(exported);
        });
        document.body.prepend(debug);
    }).apply();
};

if (document.readyState !== 'complete')
    document.addEventListener('readystatechange', _ => {
        if (document.readyState !== 'complete') return;
        onDocumentLoad();
    });
else
    onDocumentLoad();
