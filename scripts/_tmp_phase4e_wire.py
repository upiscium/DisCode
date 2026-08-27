from pathlib import Path

path = Path("src/bridge/bridge.ts")
text = path.read_text()

old_import = 'import { PermissionPublicationTracker } from "./permission-publication.js";'
new_import = '''import {
  hasPendingPermissionRequest,
  PermissionPublicationTracker,
} from "./permission-publication.js";'''
if text.count(old_import) != 1:
    raise SystemExit(f"expected one permission-publication import, got {text.count(old_import)}")
text = text.replace(old_import, new_import, 1)

old_predicate = '''    const stillPending = current.some(
      (request) => request.id === parsed.permissionId && request.sessionID === parsed.sessionId,
    );'''
new_predicate = '''    const stillPending = hasPendingPermissionRequest(
      current,
      parsed.sessionId,
      parsed.permissionId,
    );'''
if text.count(old_predicate) != 1:
    raise SystemExit(f"expected one inline pending predicate, got {text.count(old_predicate)}")
text = text.replace(old_predicate, new_predicate, 1)

path.write_text(text)
