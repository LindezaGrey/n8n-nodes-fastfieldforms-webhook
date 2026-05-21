# n8n-nodes-fastfieldforms-webhook

n8n community node for receiving FastField Forms multipart webhook submissions,
including uploads where file parts may miss per-part Content-Type headers.

The node reads the raw multipart payload and preserves file parts as binary data,
so uploads remain usable in downstream workflow steps.

## Features

- Trigger workflows from FastField Forms webhook calls
- Preserve uploaded files in n8n binary data
- Configurable request body size limit
- Configurable output filename, mime type, and fallback extension

## Installation

Install as a community node package:

```bash
npm install n8n-nodes-fastfieldforms-webhook
```

For a local development checkout:

```bash
npm install
npm run build
```

## Usage

1. Add the node FastField Forms Webhook in n8n.
2. Configure Path and optional file output settings.
3. Activate or test the workflow.
4. Send a multipart/form-data POST request from FastField Forms.

Binary file parts are emitted in item.binary. Non-file fields are emitted in
item.json.body.

## Development

```bash
npm run build
npm run lint
```

## Publish Checklist

```bash
npm install
npm run build
npm run lint
npm pack --dry-run
npm login
npm publish --access public
```

## GitHub npm Publish Workflow

This repository includes a GitHub Actions workflow at
.github/workflows/npm-publish.yml that:

- runs lint, build, and npm pack --dry-run checks
- publishes when you push a semantic version tag like v0.1.1
- supports manual runs from the Actions tab

### One-time setup

1. Create an npm access token with publish rights.
2. In GitHub, add repository secret NPM_TOKEN.

### Release flow

```bash
npm version patch
git push --follow-tags
```

The workflow will publish the new version to npm.

## License

MIT
