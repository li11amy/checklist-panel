# Checklist Panel

**Checklist Panel is an unofficial Todoist integration for GNOME Shell. It works with Todoist projects, saved filters, and Todoist filter queries — not arbitrary checklist links.**

> For people who lose every list. Here's another one.

Checklist Panel puts one Todoist checklist directly in the GNOME top panel. Open the panel menu to see tasks without keeping Todoist open in a browser tab or separate window. Tasks can be completed from the menu, or opened in Todoist instead.

## What it supports

Choose one task source:

- a **Todoist project link**, for example `https://app.todoist.com/app/project/work-…`;
- a **saved Todoist filter link**;
- a **Todoist filter query**, for example `today & p1` or `#Inbox & (today | p1 | p2)`.

The extension talks directly to the Todoist API. It does not scrape Todoist pages and does not support checklist links from other services.

## Requirements

- GNOME Shell **50**;
- a Todoist account;
- a Todoist API token;
- GNOME Keyring / Secret Service for secure token storage.

GNOME Shell 50 is the version tested for the 1.0 release. Other Shell versions are intentionally not declared until they are tested.

## Installation

### From extensions.gnome.org

After the extension is published, install **Checklist Panel** from the GNOME Extensions website or Extension Manager, then enable it and open its settings.

### Manual installation

Download the release ZIP and run:

```bash
gnome-extensions install --force checklist-panel@li11amy.github.io.zip
```

Log out and back in after replacing an existing build, then enable the extension:

```bash
gnome-extensions enable checklist-panel@li11amy.github.io
```

Open settings with:

```bash
gnome-extensions prefs checklist-panel@li11amy.github.io
```

## Setup

### 1. Add the Todoist API token

In Todoist, open **Settings → Integrations → Developer** and copy your API token. Paste it into **Todoist API token** in Checklist Panel settings and press **Save token**.

The token is stored locally in GNOME Keyring / Secret Service. It is not written to the extension settings file.

### 2. Choose a task source

Paste a Todoist project or saved-filter link into **Project / saved-filter link or filter query**.

You can also type a Todoist filter query directly, for example:

```text
today & p1
```

or:

```text
#Inbox & (today | p1 | p2)
```

### 3. Choose the filter language when needed

**Filter query language** matters only for a filter query typed manually. It tells Todoist which language is used by words such as `today`, `hoy`, `overdue`, or `vencidas`.

Examples:

- `today & p1` → **English**;
- `hoy & p1` → **Español**;
- `сегодня & p1` → **Русский (Russian)**.

Project links and saved-filter links ignore this setting. Saved filters use the language from the Todoist account automatically.

The language list follows the languages currently supported by Todoist's filter API.

## Panel settings

**Position** can be:

- Left;
- Before clock;
- After clock;
- Right.

**Show task count** adds the number of loaded tasks beside the panel icon.

**Spacing** adds extra space between the checklist icon and neighboring panel items.

**Menu title** overrides the project/filter name shown at the top of the menu.

## Behavior

With **Complete task on click** enabled, clicking a task completes it in Todoist.

With it disabled, clicking a task opens that task in the Todoist desktop app. If no Todoist URI handler is installed, Checklist Panel opens the matching Todoist page in the default browser instead.

The same app-first/browser-fallback behavior is used by **Open in Todoist** for projects and saved filters.

**Maximum tasks in menu** keeps long lists from pushing Refresh, Open in Todoist, and Settings off-screen. If more tasks exist, the menu shows a More item that opens the source in Todoist.

**Refresh interval** controls automatic updates. Opening the menu also refreshes the list.

## Errors and empty states

Checklist Panel keeps API errors short in the panel menu and writes technical details to the GNOME Shell journal.

Common cases:

- **Todoist said no. Check the API token.** — the API token is invalid;
- **Todoist looked at this filter and gave up. Check the query and its language.** — the filter query is invalid or the selected filter language does not match its keywords;
- **Nothing lives at this Todoist link anymore.** — the project/filter is missing or unavailable;
- **No connection. The tasks are probably still there.** — Todoist could not be reached.

For debugging:

```bash
journalctl -b -o cat /usr/bin/gnome-shell | grep -i 'Checklist Panel'
```

## Privacy

Checklist Panel:

- connects only to `api.todoist.com` for Todoist data;
- stores the API token locally through GNOME Secret Service;
- does not use analytics, telemetry, advertising, or tracking;
- does not send task data anywhere other than Todoist.

## Notes

Checklist Panel is an independent, unofficial project and is not affiliated with Doist or Todoist.

Todoist is a trademark of Doist. No Todoist logos or artwork are distributed with this extension.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
