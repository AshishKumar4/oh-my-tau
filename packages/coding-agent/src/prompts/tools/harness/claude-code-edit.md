Performs a string replacement in a file.

- `old_string` must match the file's text, including indentation, and be unique unless `replace_all` is true. Strip the Read line prefix (line number + tab) before matching.
- `replace_all: true` replaces every occurrence instead.
