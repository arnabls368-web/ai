# Python Workers: FastMCP Example

This is an example of a Python Worker that uses the FastMCP package.

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ai/tree/main/demos/python-workers-mcp)

> [!NOTE]
> Due to the [size](https://developers.cloudflare.com/workers/platform/limits/#worker-size) of the Worker, this example can only be deployed if you're using the Workers Paid plan. Free plan users will encounter deployment errors because this Worker exceeds the 3MB size limit.

## Developing and Deploying

To develop your Worker run:

```console
uv run pywrangler dev
```

To deploy your Worker run:

```console
uv run pywrangler deploy
```

## CORS configuration\n\nThe Worker does not allow cross-origin browser requests by default. Set the `CORS_ALLOWED_ORIGINS` Worker variable to a comma-separated list of exact origins (scheme, host, and optional port; no paths or trailing slashes). For example, `https://your-app.example.com`. Do not use `*` for deployed environments.\n\nThe local `wrangler.jsonc` example allows the Vite development origins on ports 5173. Configure the production variable for the exact browser application origins that need access.\n\n## Testing

To test run:

```console
uv run pytest tests
```

## Linting and Formatting

This project uses Ruff for linting and formatting:

```console
uv ruff format . --check
uv ruff check .
```

## IDE Integration

To have good autocompletions in your IDE simply select .venv-workers/bin/python as your IDE's interpreter.
