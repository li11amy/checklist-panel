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
