Reads a file from the local filesystem.

- `file_path` must be an absolute path, or an internal URL such as `artifact://<id>` or `rule://<name>` when a tool result or this prompt names one.
- Without `offset`/`limit`, a longer code file returns a structural summary: signatures stay, bodies are elided, and a footer gives the `offset`/`limit` that reads an elided range. Any other file returns its first lines, with a footer giving the `offset` to continue from when more remain.
- `offset` is the line number to start from; `limit` is the number of lines to return. When you already know which part of the file you need, only read that part.
- Results are returned using cat -n format, with line numbers starting at 1.
- Reads images (PNG, JPG, …) and presents them visually. Reads PDFs as extracted text, paged with `offset`/`limit`. Reads Jupyter notebooks (.ipynb) as their cells' source, without outputs.
- Reading a directory returns a listing of its entries. A missing file returns an error unless exactly one workspace file's path ends with the given path; that file is read instead, with a notice naming it. An empty file returns a notice rather than content.
