# Static UI Tree Example

This example demonstrates the complete static UI tree path using only the three built-in presentation components:

- `UI.CONTAINER`
- `UI.HEADING`
- `UI.TEXT_BLOCK`

## Run

From `engine/qx-core`, with Node.js 22 or later:

```sh
node examples/ui-tree-static/demo.js
```

No external dependencies are required.

## Files

- `tree.json` — declarative component tree data.
- `qx.ui-lock.json` — exact component contract versions, registry release IDs, and SHA-256 schema digests.
- `demo.js` — parses the tree into a QX `UI.TREE(TXT)` call, performs semantic and QIR validation, executes it in the VM, and builds static browser assets.

The example does not write generated files. It reports the VM output and the browser asset names; the returned `webProject.files` object contains `index.html`, `styles.css`, and `app.js`.

The browser renderer remains static and network-disabled. No events, input, navigation, arbitrary styling, or host capabilities are enabled.
