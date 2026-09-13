# DisCode-managed Allow Always

`Allow always` は OpenCode の `always` matcher を reliability authority として使用しない。

DisCode は、OpenCode が Ask で提示した `pattern[]` を次の exact scope で restart-safe に保存する。

- `hostId`
- canonical directory
- `sessionId`
- permission type
- exact `pattern[]`

Pattern は opaque identity であり、regex/glob/shell/environment semantics を DisCode 側で解釈・展開・正規化しない。

初回の `Allow always` は approval state を保存した後、current request に `once` を返す。同じ exact scope + pattern が後続 Ask として再提示された場合も Discord Ask を作成せず `once` を返す。

Missing / empty / malformed / oversized pattern は fail closed とし auto-allow しない。自動 `once` が失敗した場合は resolved 扱いにせず通常の Discord Ask へフォールバックする。

Approval state は pure `/oc unbind` では残り、同じ OpenCode session への rebind で再利用される。`/oc close` または confirmed `session.deleted` で session-scoped approval state を削除する。
