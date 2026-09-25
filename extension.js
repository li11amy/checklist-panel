// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 li11amy

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Secret from 'gi://Secret?version=1';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const API_BASE = 'https://api.todoist.com/api/v1';
const SECRET_SCHEMA_NAME = 'org.gnome.shell.extensions.checklist-panel.todoist';
const SECRET_ATTRIBUTES = {extension: 'checklist-panel'};

const EASTER_EGGS = new Map([
    ['deadline', 'Keep calm.'],
    ['tomorrow', "I'll think about it tomorrow."],
    ['later', 'Live for today.'],
    ['inbox zero', 'Nice try.'],
    ['42', 'Mostly harmless.'],
    ['nothing', 'Perfect plan.'],
]);

function normalizeLanguage(language) {
    const value = (language || 'en').trim();
    return (value || 'en').replaceAll('_', '-');
}

function createSecretSchema() {
    return new Secret.Schema(
        SECRET_SCHEMA_NAME,
        Secret.SchemaFlags.NONE,
        {extension: Secret.SchemaAttributeType.STRING}
    );
}

function extractTrailingId(segment) {
    if (!segment)
        return null;

    const decoded = decodeURIComponent(segment).replace(/\/$/, '');
    const suffix = decoded.match(/-([A-Za-z0-9]{8,})$/);
    if (suffix)
        return suffix[1];

    if (/^[A-Za-z0-9]{6,}$/.test(decoded))
        return decoded;

    return null;
}

function todoistWebUri(kind, id) {
    return `https://app.todoist.com/app/${kind}/${encodeURIComponent(id)}`;
}

function parseSource(source) {
    const value = source.trim();
    if (!value)
        return {kind: 'empty'};

    const explicit = value.match(/^(filter|project):\s*([A-Za-z0-9]+)$/i);
    if (explicit) {
        const type = explicit[1].toLowerCase();
        const id = explicit[2];
        return {kind: `${type}-id`, id, webUri: todoistWebUri(type, id)};
    }

    const deepLink = value.match(/^todoist:\/\/(filter|project)\?id=([^&#]+)$/i);
    if (deepLink) {
        const type = deepLink[1].toLowerCase();
        const id = decodeURIComponent(deepLink[2]);
        return {kind: `${type}-id`, id, webUri: todoistWebUri(type, id)};
    }

    // Todoist links come in several shapes; normalize them into one small set of source types.
    if (/^https?:\/\//i.test(value)) {
        const match = value.match(/^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/i);
        if (!match || !/(^|\.)todoist\.com$/i.test(match[1]))
            return {kind: 'unsupported-url'};

        const path = match[2] || '';
        const queryString = match[3] || '';
        const parts = path.split('/').filter(Boolean);
        const typeIndex = parts.findIndex(part => part === 'filter' || part === 'project');
        if (typeIndex >= 0 && parts[typeIndex + 1]) {
            const id = extractTrailingId(parts[typeIndex + 1]);
            if (id)
                return {kind: `${parts[typeIndex]}-id`, id, webUri: value};
        }

        const idMatch = queryString.match(/(?:^|&)id=([^&]+)/i);
        if (idMatch && /filter/i.test(path))
            return {kind: 'filter-id', id: decodeURIComponent(idMatch[1]), webUri: value};
        if (idMatch && /project/i.test(path))
            return {kind: 'project-id', id: decodeURIComponent(idMatch[1]), webUri: value};

        return {kind: 'unsupported-url'};
    }

    return {kind: 'query', query: value};
}

function splitTopLevelQueries(query) {
    const result = [];
    let depth = 0;
    let start = 0;

    for (let i = 0; i < query.length; i++) {
        if (query[i] === '(')
            depth++;
        else if (query[i] === ')')
            depth = Math.max(0, depth - 1);
        else if (query[i] === ',' && depth === 0) {
            const part = query.slice(start, i).trim();
            if (part)
                result.push(part);
            start = i + 1;
        }
    }

    const last = query.slice(start).trim();
    if (last)
        result.push(last);

    return result.length > 0 ? result : [query];
}

class TodoistProvider {
    constructor(session, cancellable, token, language) {
        this._session = session;
        this._cancellable = cancellable;
        this._token = token;
        this._language = normalizeLanguage(language);
    }

    _send(message, callback) {
        message.request_headers.append('Authorization', `Bearer ${this._token}`);
        message.request_headers.append('Accept', 'application/json');

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            this._cancellable,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const status = message.get_status();
                    const body = new TextDecoder().decode(bytes.get_data());
                    callback(null, status, body);
                } catch (error) {
                    if (!this._cancellable.is_cancelled())
                        callback(error, 0, '');
                }
            }
        );
    }

    _get(url, callback) {
        const message = Soup.Message.new('GET', url);
        this._send(message, callback);
    }

    resolveFilter(filterId, callback) {
        const form = Soup.form_encode_hash({
            sync_token: '*',
            resource_types: '["filters","user"]',
        });
        const message = Soup.Message.new_from_encoded_form(
            'POST',
            `${API_BASE}/sync`,
            form
        );

        this._send(message, (error, status, body) => {
            if (error || status < 200 || status >= 300) {
                callback(error ?? new Error(`HTTP ${status}`));
                return;
            }

            try {
                const data = JSON.parse(body || '{}');
                const filter = (data.filters ?? []).find(item => String(item.id) === String(filterId));
                if (!filter) {
                    callback(new Error('Saved filter not found'));
                    return;
                }

                // Saved filters already know their language. Manual queries, unfortunately, do not.
                callback(null, {
                    title: filter.name || 'Checklist',
                    query: filter.query,
                    openUri: `todoist://filter?id=${encodeURIComponent(filter.id)}`,
                    language: normalizeLanguage(data.user?.lang || 'en'),
                });
            } catch (parseError) {
                callback(parseError);
            }
        });
    }

    resolveProject(projectId, callback) {
        this._get(`${API_BASE}/projects/${encodeURIComponent(projectId)}`, (error, status, body) => {
            if (error || status < 200 || status >= 300) {
                callback(error ?? new Error(`HTTP ${status}`));
                return;
            }

            try {
                const project = JSON.parse(body || '{}');
                callback(null, {
                    title: project.name || 'Checklist',
                    projectId,
                    openUri: `todoist://project?id=${encodeURIComponent(projectId)}`,
                });
            } catch (parseError) {
                callback(parseError);
            }
        });
    }

    fetchProjectTasks(projectId, callback) {
        const url = `${API_BASE}/tasks?project_id=${encodeURIComponent(projectId)}&limit=200`;
        this._get(url, (error, status, body) => this._parseTaskResponse(error, status, body, callback));
    }

    fetchFilterTasks(query, language, callback) {
        const queries = splitTopLevelQueries(query);
        const tasks = new Map();
        let hasMore = false;

        const next = index => {
            if (index >= queries.length) {
                callback(null, [...tasks.values()], hasMore);
                return;
            }

            let url = `${API_BASE}/tasks/filter?query=${encodeURIComponent(queries[index])}&limit=200`;
            const queryLanguage = normalizeLanguage(language || this._language);
            if (queryLanguage)
                url += `&lang=${encodeURIComponent(queryLanguage)}`;

            this._get(url, (error, status, body) => {
                this._parseTaskResponse(error, status, body, (parseError, pageTasks, pageHasMore) => {
                    if (parseError) {
                        callback(parseError);
                        return;
                    }

                    for (const task of pageTasks)
                        tasks.set(String(task.id), task);
                    hasMore ||= pageHasMore;
                    next(index + 1);
                });
            });
        };

        next(0);
    }

    _parseTaskResponse(error, status, body, callback) {
        if (error || status < 200 || status >= 300) {
            let detail = '';
            if (body) {
                try {
                    const payload = JSON.parse(body);
                    detail = payload.error || payload.message || payload.detail || '';
                } catch (_parseError) {
                    detail = body.trim().slice(0, 180);
                }
            }
            callback(error ?? new Error(`HTTP ${status}${detail ? `: ${detail}` : ''}`));
            return;
        }

        try {
            const data = JSON.parse(body || '{}');
            const tasks = Array.isArray(data) ? data : (data.results ?? []);
            callback(null, tasks, Boolean(data.next_cursor));
        } catch (parseError) {
            callback(parseError);
        }
    }

    completeTask(taskId, callback) {
        const message = Soup.Message.new(
            'POST',
            `${API_BASE}/tasks/${encodeURIComponent(taskId)}/close`
        );
        this._send(message, (error, status) => {
            if (error || status < 200 || status >= 300)
                callback(error ?? new Error(`HTTP ${status}`));
            else
                callback(null);
        });
    }
}

const ChecklistIndicator = GObject.registerClass(
class ChecklistIndicator extends PanelMenu.Button {
    _init(extension, settings, token) {
        super._init(0.0, extension.metadata.name);

        this._extension = extension;
        this._settings = settings;
        this._token = token;
        this._session = new Soup.Session({timeout: 20});
        this._cancellable = new Gio.Cancellable();
        this._refreshSource = 0;
        this._busy = false;
        this._resolvedSource = null;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'view-list-symbolic',
            style_class: 'system-status-icon',
        });
        this._countLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'checklist-panel-count',
        });
        box.add_child(this._icon);
        box.add_child(this._countLabel);
        this.add_child(box);

        this._applySpacing();
        this._updateCount(0);

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this.refresh();
        });

        this._renderMessage('Loading…');
        this.refresh();
        this._installTimer();
    }

    _applySpacing() {
        const spacing = Math.min(32, this._settings.get_uint('spacing-px'));
        const position = this._settings.get_string('panel-position');
        if (position === 'before-clock' || position === 'center')
            this.set_style(`margin-right: ${spacing}px;`);
        else if (position === 'after-clock')
            this.set_style(`margin-left: ${spacing}px;`);
        else
            this.set_style(`margin-left: ${Math.floor(spacing / 2)}px; margin-right: ${Math.ceil(spacing / 2)}px;`);
    }

    _installTimer() {
        const seconds = Math.max(60, this._settings.get_uint('refresh-seconds'));
        this._refreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            seconds,
            () => {
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _provider() {
        return new TodoistProvider(
            this._session,
            this._cancellable,
            this._token,
            this._settings.get_string('filter-language')
        );
    }

    _displayTitle(fallback = 'Checklist') {
        const customTitle = this._settings.get_string('menu-title').trim();
        return customTitle || this._resolvedSource?.title || fallback;
    }

    _easterEggText() {
        const key = this._settings.get_string('menu-title').trim().toLowerCase();
        return EASTER_EGGS.get(key) ?? '';
    }

    _addEasterEgg() {
        const text = this._easterEggText();
        if (!text)
            return;

        const item = new PopupMenu.PopupMenuItem(text, {
            reactive: false,
            can_focus: false,
        });
        item.label.add_style_class_name('checklist-panel-easter-egg');
        this.menu.addMenuItem(item);
    }

    _updateCount(count) {
        const show = this._settings.get_boolean('show-count');
        this._countLabel.visible = show;
        this._countLabel.text = show ? String(count) : '';
    }

    _addFooter() {
        this._addEasterEgg();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh');
        refreshItem.connect('activate', () => this.refresh());
        this.menu.addMenuItem(refreshItem);

        if (this._resolvedSource?.openUri || this._resolvedSource?.webUri) {
            const openItem = new PopupMenu.PopupMenuItem('Open in Todoist');
            openItem.connect('activate', () => this._openTodoist(
                this._resolvedSource.openUri,
                this._resolvedSource.webUri
            ));
            this.menu.addMenuItem(openItem);
        }

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settingsItem);
    }

    _renderMessage(text) {
        this.menu.removeAll();

        const title = new PopupMenu.PopupMenuItem(this._displayTitle(), {
            reactive: false,
            can_focus: false,
        });
        title.label.add_style_class_name('checklist-panel-title');
        this.menu.addMenuItem(title);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(new PopupMenu.PopupMenuItem(text, {
            reactive: false,
            can_focus: false,
        }));
        this._addFooter();
    }

    _renderTasks(tasks, hasMore = false) {
        this.menu.removeAll();
        this._updateCount(tasks.length);

        // Keep the footer reachable even for people with heroic task backlogs.
        const maxItems = Math.max(5, Math.min(30, this._settings.get_uint('max-menu-items')));
        const visibleTasks = tasks.slice(0, maxItems);
        const hiddenCount = Math.max(0, tasks.length - visibleTasks.length);
        const suffix = tasks.length > 0 ? ` · ${tasks.length}${hasMore ? '+' : ''}` : '';
        const title = new PopupMenu.PopupMenuItem(`${this._displayTitle()}${suffix}`, {
            reactive: false,
            can_focus: false,
        });
        title.label.add_style_class_name('checklist-panel-title');
        this.menu.addMenuItem(title);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (visibleTasks.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem('Nothing here. Suspiciously productive.', {
                reactive: false,
                can_focus: false,
            }));
        } else {
            for (const task of visibleTasks) {
                const item = new PopupMenu.PopupMenuItem(`☐  ${task.content}`);
                item.connect('activate', () => this._activateTask(task));
                this.menu.addMenuItem(item);
            }

            if (hiddenCount > 0 || hasMore) {
                const moreText = hasMore
                    ? 'More tasks…'
                    : `${hiddenCount} more task${hiddenCount === 1 ? '' : 's'}…`;
                const moreItem = new PopupMenu.PopupMenuItem(moreText);
                moreItem.connect('activate', () => {
                    this._openTodoist(
                        this._resolvedSource?.openUri,
                        this._resolvedSource?.webUri
                    );
                });
                this.menu.addMenuItem(moreItem);
            }
        }

        this._addFooter();
    }

    _activateTask(task) {
        if (!this._settings.get_boolean('complete-on-click')) {
            this._openTodoist(
                `todoist://task?id=${encodeURIComponent(task.id)}`,
                `https://app.todoist.com/app/task/${encodeURIComponent(task.id)}`
            );
            return;
        }

        if (this._busy)
            return;

        this._busy = true;
        this._provider().completeTask(task.id, error => {
            this._busy = false;
            if (error) {
                Main.notify(this._displayTitle(), `Todoist refused to tick off “${task.content}”.`);
                return;
            }
            this.refresh();
        });
    }

    _openTodoist(deepUri, webUri) {
        // Prefer the desktop app when it registered Todoist's URL scheme; otherwise use the browser.
        if (deepUri && Gio.AppInfo.get_default_for_uri_scheme('todoist')) {
            try {
                Gio.AppInfo.launch_default_for_uri(deepUri, null);
                return;
            } catch (error) {
                console.error(`[Checklist Panel] Could not open Todoist app: ${error}`);
            }
        }

        if (!webUri)
            webUri = 'https://app.todoist.com/app';

        try {
            Gio.AppInfo.launch_default_for_uri(webUri, null);
        } catch (error) {
            console.error(`[Checklist Panel] Could not open Todoist in browser: ${error}`);
        }
    }

    refresh() {
        if (this._busy)
            return;

        if (!this._token) {
            this._updateCount(0);
            this._renderMessage('Add your API token in Settings.');
            return;
        }

        const sourceText = this._settings.get_string('source');
        const source = parseSource(sourceText);
        if (source.kind === 'empty') {
            this._updateCount(0);
            this._renderMessage('Paste a filter/project link or enter a filter query in Settings.');
            return;
        }

        if (source.kind === 'unsupported-url') {
            this._updateCount(0);
            this._renderMessage('That link is not a Todoist project or saved filter.');
            return;
        }

        this._busy = true;
        const provider = this._provider();

        if (source.kind === 'query') {
            this._resolvedSource = {
                title: 'Checklist',
                query: source.query,
                openUri: `todoist://search?query=${encodeURIComponent(source.query)}`,
                webUri: 'https://app.todoist.com/app',
            };
            provider.fetchFilterTasks(source.query, this._settings.get_string('filter-language'), (error, tasks, hasMore) => {
                this._finishRefresh(error, tasks, hasMore);
            });
            return;
        }

        if (source.kind === 'filter-id') {
            const useResolved = this._resolvedSource?.kind === source.kind &&
                this._resolvedSource?.id === source.id && this._resolvedSource?.query;
            if (useResolved) {
                provider.fetchFilterTasks(this._resolvedSource.query, this._resolvedSource.language, (error, tasks, hasMore) => {
                    this._finishRefresh(error, tasks, hasMore);
                });
                return;
            }

            provider.resolveFilter(source.id, (error, resolved) => {
                if (error) {
                    this._finishRefresh(error);
                    return;
                }
                this._resolvedSource = {
                    kind: source.kind,
                    id: source.id,
                    ...resolved,
                    webUri: source.webUri ?? todoistWebUri('filter', source.id),
                };
                provider.fetchFilterTasks(resolved.query, resolved.language, (tasksError, tasks, hasMore) => {
                    this._finishRefresh(tasksError, tasks, hasMore);
                });
            });
            return;
        }

        if (source.kind === 'project-id') {
            const useResolved = this._resolvedSource?.kind === source.kind &&
                this._resolvedSource?.id === source.id;
            if (useResolved) {
                provider.fetchProjectTasks(source.id, (error, tasks, hasMore) => {
                    this._finishRefresh(error, tasks, hasMore);
                });
                return;
            }

            provider.resolveProject(source.id, (error, resolved) => {
                if (error) {
                    this._finishRefresh(error);
                    return;
                }
                this._resolvedSource = {
                    kind: source.kind,
                    id: source.id,
                    ...resolved,
                    webUri: source.webUri ?? todoistWebUri('project', source.id),
                };
                provider.fetchProjectTasks(source.id, (tasksError, tasks, hasMore) => {
                    this._finishRefresh(tasksError, tasks, hasMore);
                });
            });
        }
    }

    _finishRefresh(error, tasks = [], hasMore = false) {
        this._busy = false;
        if (this._cancellable.is_cancelled())
            return;

        if (error) {
            this._updateCount(0);
            const message = String(error.message || error);
            if (/HTTP 0|network|connection|timed? ?out|resolve|offline/i.test(message))
                this._renderMessage('No connection. The tasks are probably still there.');
            else if (/401/.test(message))
                this._renderMessage('Todoist said no. Check the API token.');
            else if (/403/.test(message))
                this._renderMessage('Todoist said no. This token cannot access that source.');
            else if (/not found/i.test(message) || /404/.test(message))
                this._renderMessage('Nothing lives at this Todoist link anymore.');
            else if (/400/.test(message))
                this._renderMessage('Todoist looked at this filter and gave up. Check the query and its language.');
            else
                this._renderMessage('Something went sideways. Refresh and try again.');
            console.error(`[Checklist Panel] ${error}`);
            return;
        }

        this._renderTasks(tasks, hasMore);
    }

    destroy() {
        if (this._refreshSource) {
            GLib.Source.remove(this._refreshSource);
            this._refreshSource = 0;
        }

        this._cancellable.cancel();
        this._session.abort();
        this._resolvedSource = null;
        super.destroy();
    }
});

export default class ChecklistPanelExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._secretSchema = createSecretSchema();
        this._settingsChangedId = this._settings.connect('changed', () => this._queueRebuild());
        this._rebuildSource = 0;
        this._rebuild();
    }

    _queueRebuild() {
        if (this._rebuildSource)
            return;

        this._rebuildSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this._rebuildSource = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _lookupToken() {
        try {
            return Secret.password_lookup_sync(
                this._secretSchema,
                SECRET_ATTRIBUTES,
                null
            ) ?? '';
        } catch (error) {
            console.error(`[Checklist Panel] Could not read API token from Secret Service: ${error}`);
            return '';
        }
    }

    _rebuild() {
        this._indicator?.destroy();
        this._indicator = null;

        const position = this._settings.get_string('panel-position');
        const box = position === 'left' ? 'left' : position === 'right' ? 'right' : 'center';
        const index = position === 'after-clock' ? 1 : 0;
        const token = this._lookupToken();

        this._indicator = new ChecklistIndicator(this, this._settings, token);
        Main.panel.addToStatusArea(this.uuid, this._indicator, index, box);
    }

    disable() {
        // GNOME remembers extension code surprisingly well. Clean up everything we create.
        if (this._rebuildSource) {
            GLib.Source.remove(this._rebuildSource);
            this._rebuildSource = 0;
        }

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._secretSchema = null;
        this._settings = null;
    }
}
