# Publishing Checklist

## Before the first EGO upload

1. Create the public repository: `https://github.com/li11amy/checklist-panel`.
2. Push the source tree from `checklist-panel-source-1.0.zip` to that repository.
3. Confirm the repository URL in `metadata.json` is reachable without authentication.
4. Test `checklist-panel@li11amy.github.io.zip` on GNOME Shell 50.
5. Confirm enable → disable → enable does not duplicate the indicator, timers, or signals.
6. Test a project link, a saved-filter link, a manual English query, a non-English manual query, an invalid token, an invalid query, and offline behavior.
7. Upload only `checklist-panel@li11amy.github.io.zip` to extensions.gnome.org.

The EGO ZIP intentionally contains only files needed by the installed extension plus the license. README, changelog, and publishing notes belong in the source repository, not in the EGO upload.
