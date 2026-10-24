# Security Policy

## Reporting a vulnerability

Please email **nupotecrosstvo@gmail.com** instead of opening a public issue.

Include what you can:

- the plugin version (`v0.2.4` or the commit you installed),
- your DSH version,
- what the plugin did that it should not have done, and how to reproduce it.

I will reply within a few days. Do **not** include access tokens, API keys, or session logs that
contain credentials — redact them first.

## Scope

This plugin is client-side only: it reads the model catalog and the session's model selection and
writes through `session.selectModel`. It registers no HTTP route, no tool, and no Host service, so
anything that would require network or filesystem access is out of scope by construction.
