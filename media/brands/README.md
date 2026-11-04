# Session identification marks

These assets identify the CLI associated with a session. They are not TmuxDock's
product branding and do not imply affiliation with or endorsement by their owners.
The original SVG paths, dimensions and colors are preserved byte-for-byte.

## Codex / OpenAI

- Source: official `openai.chatgpt` VS Code extension, version `26.1021.22027`.
- `codex-light.svg`: `resources/blossom-black.svg`.
- `codex-dark.svg`: `resources/blossom-white.svg`.
- This is the same Blossom mark used in that extension's Codex sidebar.
- Publisher: OpenAI. Marks belong to OpenAI.
- https://marketplace.visualstudio.com/items?itemName=OpenAI.chatgpt
- https://openai.com/brand/

## Claude

- Source: official `Anthropic.claude-code` VS Code extension, version `2.1.317`.
- `claude.svg`: `resources/claude-logo.svg` (original terracotta mark).
- SHA-256: `a3101f3047a119aa11825ad9369510f0c472428c8c52d420e31bc62db44a8364`.
- Publisher: Anthropic. Marks belong to Anthropic.
- https://marketplace.visualstudio.com/items?itemName=Anthropic.claude-code

## Persistent terminal icons

`session-marks.woff` contains the same official SVG outlines converted to font
glyphs (Codex U+E001, Claude U+E002). VS Code registers them as ThemeIcons so
native terminal restoration stores stable IDs instead of nested image URIs.
Rebuild with `python scripts/build-brand-font.py` using `fonttools==4.60.1`.
Claude retains `#D97757`; Codex follows the current theme foreground.

Terminals created before 2.4.3 still contain their old image icon in VS Code’s
native state. Close their terminal tabs and attach again once from TmuxDock.
This detaches the local terminal only; it does not stop tmux or restart agents.
