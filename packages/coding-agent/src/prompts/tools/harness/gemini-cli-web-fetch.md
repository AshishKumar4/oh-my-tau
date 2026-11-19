Fetches the first `http://` or `https://` URL named in `prompt`, converts the page to markdown, and answers `prompt` against it using a small fast model.

- Name one URL per call; later URLs in the same prompt are not fetched.
- Fails on authenticated/private URLs.
- For local files, use read_file.
