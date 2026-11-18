Executes a mounted `xd://` tool device: `file_path` is `xd://<tool>` and `content` is the device's JSON arguments object. Read `xd://` to list the mounted devices, and `xd://<tool>` for a device's full docs.

Outside active plan mode, this tool rejects every non-`xd://` path. During plan mode, it can also write `local://` sandbox drafts required by that workflow; working-tree paths remain rejected.
