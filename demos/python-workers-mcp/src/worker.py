from workers import DurableObject


def setup_server(env):
    from starlette.middleware import Middleware
    from starlette.middleware.cors import CORSMiddleware
    from mcp.server.fastmcp import FastMCP

    from exceptions import HTTPException, http_exception

    mcp = FastMCP("Demo")

    @mcp.tool()
    def add(a: int, b: int) -> int:
        """Add two numbers"""
        return a + b

    @mcp.resource("greeting://{name}")
    def get_greeting(name: str) -> str:
        """Get a personalized greeting"""
        return f"Hello, {name}!"

    @mcp.tool()
    def calculate_bmi(weight_kg: float, height_m: float) -> float:
        """Calculate BMI given weight in kg and height in meters"""
        return weight_kg / (height_m**2)

    @mcp.prompt()
    def echo_prompt(message: str) -> str:
        """Create an echo prompt"""
        return f"Please process this message: {message}"

    app = mcp.sse_app()
    app.add_exception_handler(HTTPException, http_exception)
    allowed_origins = [\n        origin.strip()\n        for origin in getattr(env, "CORS_ALLOWED_ORIGINS", "").split(",")\n        if origin.strip()\n    ]\n    app.add_middleware(\n        CORSMiddleware,\n        allow_origins=allowed_origins,\n        allow_methods=["GET", "POST", "OPTIONS"],\n        allow_headers=["authorization", "content-type", "last-event-id", "mcp-protocol-version", "mcp-session-id"],\n    )
    return mcp, app


class FastMCPServer(DurableObject):
    def __init__(self, ctx, env):
        self.ctx = ctx
        self.env = env
        self.mcp, self.app = setup_server(env)

    async def on_fetch(self, request, env, ctx):
        import asgi

        return await asgi.fetch(self.app, request, self.env, self.ctx)


async def on_fetch(request, env):
    id = env.ns.idFromName("A")
    obj = env.ns.get(id)
    return await obj.fetch(request)