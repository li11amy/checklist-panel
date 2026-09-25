// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 li11amy

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk?version=4.0';
import Secret from 'gi://Secret?version=1';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SECRET_SCHEMA_NAME = 'org.gnome.shell.extensions.checklist-panel.todoist';
const SECRET_ATTRIBUTES = {extension: 'checklist-panel'};

const LANGUAGE_OPTIONS = [
    ['da', 'Dansk'],
    ['de', 'Deutsch'],
    ['en', 'English'],
    ['es', 'Español'],
    ['fi', 'Suomi'],
    ['fr', 'Français'],
    ['it', 'Italiano'],
    ['ja', '日本語'],
    ['ko', '한국어'],
    ['nl', 'Nederlands'],
    ['pl', 'Polski'],
    ['pt-BR', 'Português (Brazil)'],
    ['ru', 'Русский (Russian)'],
    ['tr', 'Türkçe'],
    ['sv', 'Svenska'],
    ['zh-CN', '中文 (简体)'],
    ['zh-TW', '中文 (繁體)'],
];

function createSecretSchema() {
    return new Secret.Schema(
        SECRET_SCHEMA_NAME,
        Secret.SchemaFlags.NONE,
        {extension: Secret.SchemaAttributeType.STRING}
    );
}

function addSwitchRow(group, title, subtitle, initial, onChanged) {
    const row = new Adw.ActionRow({title, subtitle});
    const toggle = new Gtk.Switch({
        active: initial,
        valign: Gtk.Align.CENTER,
    });
    row.add_suffix(toggle);
    row.activatable_widget = toggle;
    toggle.connect('notify::active', widget => onChanged(widget.active));
    group.add(row);
}

function addSpinRow(group, title, subtitle, value, lower, upper, step, onChanged) {
    const row = new Adw.ActionRow({title, subtitle});
    const adjustment = new Gtk.Adjustment({
        value,
        lower,
        upper,
        step_increment: step,
        page_increment: step * 5,
    });
    const spin = new Gtk.SpinButton({
        adjustment,
        numeric: true,
        valign: Gtk.Align.CENTER,
    });
    row.add_suffix(spin);
    row.activatable_widget = spin;
    spin.connect('value-changed', widget => onChanged(Math.round(widget.get_value())));
    group.add(row);
}

function addTextRow(group, title, text, onChanged, options = {}) {
    const row = new Adw.ActionRow({title, subtitle: options.subtitle ?? ''});
    const entry = new Gtk.Entry({
        text,
        hexpand: true,
        width_chars: options.widthChars ?? 38,
        valign: Gtk.Align.CENTER,
        placeholder_text: options.placeholder ?? '',
    });
    row.add_suffix(entry);
    row.activatable_widget = entry;
    entry.connect('changed', widget => onChanged(widget.text));
    group.add(row);
    return {row, entry};
}

export default class ChecklistPanelPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const secretSchema = createSecretSchema();
        window._settings = settings;
        window._secretSchema = secretSchema;
        window.set_default_size(680, 720);

        const page = new Adw.PreferencesPage({
            title: 'Checklist Panel',
            icon_name: 'view-list-symbolic',
        });
        window.add(page);

        const sourceGroup = new Adw.PreferencesGroup({
            title: 'Task source',
            description: 'Paste a Todoist project or saved-filter link, or enter a filter query such as “today & p1”. Settings are saved automatically.',
        });
        page.add(sourceGroup);

        let storedToken = '';
        try {
            storedToken = Secret.password_lookup_sync(secretSchema, SECRET_ATTRIBUTES, null) ?? '';
        } catch (error) {
            console.error(`[Checklist Panel] Could not read API token: ${error}`);
        }

        const tokenRow = new Adw.ActionRow({
            title: 'Todoist API token',
            subtitle: 'Stored in GNOME Keyring / Secret Service.',
        });
        const tokenEntry = new Gtk.PasswordEntry({
            text: storedToken,
            show_peek_icon: true,
            hexpand: true,
            width_chars: 28,
            valign: Gtk.Align.CENTER,
        });
        const saveTokenButton = new Gtk.Button({
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });

        const updateTokenButton = () => {
            const current = tokenEntry.text.trim();
            if (current === storedToken) {
                saveTokenButton.label = current ? 'Saved' : 'No token';
                saveTokenButton.sensitive = false;
            } else {
                saveTokenButton.label = current ? 'Save token' : 'Remove token';
                saveTokenButton.sensitive = true;
            }
        };

        saveTokenButton.connect('clicked', () => {
            const token = tokenEntry.text.trim();
            try {
                if (token) {
                    Secret.password_store_sync(
                        secretSchema,
                        SECRET_ATTRIBUTES,
                        Secret.COLLECTION_DEFAULT,
                        'Checklist Panel — Todoist API token',
                        token,
                        null
                    );
                } else {
                    Secret.password_clear_sync(secretSchema, SECRET_ATTRIBUTES, null);
                }
                storedToken = token;
                settings.set_uint('token-version', settings.get_uint('token-version') + 1);
                updateTokenButton();
            } catch (error) {
                saveTokenButton.label = 'Save failed';
                saveTokenButton.sensitive = true;
                console.error(`[Checklist Panel] Could not save API token: ${error}`);
            }
        });
        tokenEntry.connect('changed', updateTokenButton);
        tokenRow.add_suffix(tokenEntry);
        tokenRow.add_suffix(saveTokenButton);
        sourceGroup.add(tokenRow);
        updateTokenButton();
        addTextRow(
            sourceGroup,
            'Project / saved-filter link or filter query',
            settings.get_string('source'),
            value => settings.set_string('source', value.trim()),
            {placeholder: 'https://app.todoist.com/app/project/… or today & p1'}
        );

        const languageRow = new Adw.ComboRow({
            title: 'Filter query language',
            subtitle: 'Language used by words inside a manually typed Todoist filter. For example, choose Español for “hoy” or English for “today”. Ignored for project and saved-filter links.',
            model: Gtk.StringList.new(LANGUAGE_OPTIONS.map(([, label]) => label)),
        });
        const currentLanguage = settings.get_string('filter-language') || 'en';
        const languageIndex = LANGUAGE_OPTIONS.findIndex(([code]) => code === currentLanguage);
        languageRow.selected = languageIndex >= 0 ? languageIndex : 0;
        languageRow.connect('notify::selected', row => {
            const [code] = LANGUAGE_OPTIONS[row.selected] ?? LANGUAGE_OPTIONS[0];
            settings.set_string('filter-language', code);
        });
        sourceGroup.add(languageRow);

        const appearanceGroup = new Adw.PreferencesGroup({
            title: 'Panel',
            description: 'These settings are applied automatically.',
        });
        page.add(appearanceGroup);

        addTextRow(
            appearanceGroup,
            'Menu title (optional)',
            settings.get_string('menu-title'),
            value => settings.set_string('menu-title', value.trim()),
            {widthChars: 28}
        );

        const positionOptions = [
            ['left', 'Left'],
            ['before-clock', 'Before clock'],
            ['after-clock', 'After clock'],
            ['right', 'Right'],
        ];
        const positionRow = new Adw.ComboRow({
            title: 'Position',
            model: Gtk.StringList.new(positionOptions.map(([, label]) => label)),
        });
        let currentPosition = settings.get_string('panel-position');
        if (currentPosition === 'center')
            currentPosition = 'before-clock';
        const positionIndex = positionOptions.findIndex(([value]) => value === currentPosition);
        positionRow.selected = positionIndex >= 0 ? positionIndex : 1;
        positionRow.connect('notify::selected', row => {
            const [value] = positionOptions[row.selected] ?? positionOptions[1];
            settings.set_string('panel-position', value);
        });
        appearanceGroup.add(positionRow);

        addSwitchRow(
            appearanceGroup,
            'Show task count',
            'Display the number of loaded tasks beside the icon.',
            settings.get_boolean('show-count'),
            value => settings.set_boolean('show-count', value)
        );

        addSpinRow(
            appearanceGroup,
            'Spacing',
            'Extra space between the checklist icon and neighboring panel items.',
            settings.get_uint('spacing-px'),
            0,
            32,
            1,
            value => settings.set_uint('spacing-px', value)
        );

        const behaviorGroup = new Adw.PreferencesGroup({title: 'Behavior'});
        page.add(behaviorGroup);

        addSwitchRow(
            behaviorGroup,
            'Complete task on click',
            'When disabled, clicking a task opens it in the Todoist app, or in your browser if the app is not installed.',
            settings.get_boolean('complete-on-click'),
            value => settings.set_boolean('complete-on-click', value)
        );

        addSpinRow(
            behaviorGroup,
            'Maximum tasks in menu',
            'Limits menu height so Refresh, Open and Settings always stay reachable.',
            settings.get_uint('max-menu-items'),
            5,
            30,
            1,
            value => settings.set_uint('max-menu-items', value)
        );

        addSpinRow(
            behaviorGroup,
            'Refresh interval',
            'Seconds between automatic updates. Minimum: 60.',
            settings.get_uint('refresh-seconds'),
            60,
            3600,
            60,
            value => settings.set_uint('refresh-seconds', value)
        );
    }
}
