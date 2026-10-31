# Changelog

## 1.1.1

- Fixed the recycle-bin UI falling back to English after a restart: locale is read
  from the DSH locale service, with browser languages as a fallback, and the
  components re-render when the locale changes.
- Deleting a conversation is no longer blocked by an idle attached session.
  Only a turn that is actually running is refused; other conversations can run
  at the same time. An idle attached session is detached so its persistence
  write handle closes before the directory moves.
- Rename/move operations retry briefly on Windows `EBUSY`/`EPERM` handle contention.
- The diagnostic marker now records the last deletion error code/message.

## 1.1.0

- Delete now moves conversations into a recycle bin instead of removing them.
- Added sidebar footer **Recycle bin** entry with a live count badge.
- Added recycle-bin modal: list, restore, permanent delete, empty.
- Added Host routes for trash list/restore/purge/empty.
- Restores workspace membership, pin/archive state, and projection cache when possible.
- Added path validation and rollback on failed moves.
- Updated documentation and tests.

## 1.0.0

- Initial release: red Delete row in the conversation “…” menu.
- Permanent removal of session logs, projection cache, and workspace references.
