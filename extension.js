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

