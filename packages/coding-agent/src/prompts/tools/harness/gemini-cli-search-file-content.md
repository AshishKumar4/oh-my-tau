Searches file contents for a regular expression and returns matching lines with their file paths and line numbers.

- `dir_path` limits the search; `include` filters files by glob, such as `*.ts`.
- Matching ignores case unless `case_sensitive` is true; `fixed_strings` treats `pattern` as literal text.
