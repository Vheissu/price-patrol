import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import process from "node:process";

type DevProcess = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
};

const COLORS: Record<string, string> = {
  api: "\u001b[32m",
  web: "\u001b[34m",
  mcp: "\u001b[35m"
};

const RESET = "\u001b[0m";

async function main() {
  const requestedApiPort = parsePort(process.env.PORT, 8787);
  const apiPort = await findAvailablePort(requestedApiPort, new Set(), "0.0.0.0");
  const requestedWebPort = parsePort(process.env.PRICE_PATROL_WEB_PORT, 9000);
  const webPort = await findAvailablePort(requestedWebPort, new Set([apiPort]), "127.0.0.1");
  const apiUrl = process.env.PRICE_PATROL_API_URL ?? `http://127.0.0.1:${apiPort}`;

  writeBanner("Price Patrol dev ports");
  writeLine(`API: ${apiUrl}${apiPort === requestedApiPort ? "" : ` (default ${requestedApiPort} was busy)`}`);
  writeLine(`Web: http://127.0.0.1:${webPort}${webPort === requestedWebPort ? "" : ` (default ${requestedWebPort} was busy)`}`);
  writeLine("MCP: stdio");
  writeLine("");

  const children: ChildProcess[] = [];
  let shuttingDown = false;

  const processes: DevProcess[] = [
    {
      name: "api",
      command: npmCommand(),
      args: ["run", "dev:api"],
      env: {
        PORT: String(apiPort),
        PRICE_PATROL_BROWSER_PROFILE: "api"
      }
    },
    {
      name: "web",
      command: npmCommand(),
      args: ["run", "dev:web"],
      env: {
        PRICE_PATROL_API_URL: apiUrl,
        PRICE_PATROL_WEB_PORT: String(webPort)
      }
    },
    {
      name: "mcp",
      command: npmCommand(),
      args: ["run", "dev:mcp"],
      env: {
        PRICE_PATROL_API_URL: apiUrl,
        PRICE_PATROL_BROWSER_PROFILE: "mcp"
      }
    }
  ];

  const shutdown = (exitCode = 0) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    }
    setTimeout(() => {
      for (const child of children) {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }
    }, 2_000).unref();
    process.exitCode = exitCode;
  };

  process.on("SIGINT", () => shutdown(130));
  process.on("SIGTERM", () => shutdown(143));

  for (const definition of processes) {
    const child = spawn(definition.command, definition.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...definition.env
      },
      stdio: ["inherit", "pipe", "pipe"]
    });

    children.push(child);
    bindOutput(child.stdout, definition.name);
    bindOutput(child.stderr, definition.name);

    child.on("exit", (code, signal) => {
      if (shuttingDown) {
        return;
      }

      const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
      writeLine(`${definition.name} exited with ${detail}`);
      shutdown(code ?? 0);
    });
  }
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function bindOutput(stream: NodeJS.ReadableStream | null, name: string): void {
  if (!stream) {
    return;
  }

  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      writePrefixed(name, line);
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) {
      writePrefixed(name, buffer);
    }
  });
}

function writeBanner(title: string): void {
  writeLine(title);
  writeLine("=".repeat(title.length));
}

function writePrefixed(name: string, line: string): void {
  const color = COLORS[name] ?? "";
  process.stdout.write(`${color}[${name}]${RESET} ${line}\n`);
}

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function parsePort(rawValue: string | undefined, fallback: number): number {
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    return fallback;
  }
  return parsed;
}

async function findAvailablePort(startPort: number, reserved = new Set<number>(), host = "127.0.0.1"): Promise<number> {
  let candidate = startPort;
  while (reserved.has(candidate) || !(await isPortAvailable(candidate, host))) {
    candidate += 1;
    if (candidate > 65_535) {
      throw new Error("Unable to find a free development port.");
    }
  }
  return candidate;
}

function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
