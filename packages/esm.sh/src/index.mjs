import fs from "./fs.mjs";
import markdown from "./markdown.mjs";
import {
  enc,
  globToRegExp,
  isJSONResponse,
  isLocalHost,
  isNEString,
  isNullish,
  isObject,
  lookupValue,
  readTextFromStream,
} from "./util.mjs";

const HOT_URL = "https://esm.sh/v135/hot";

/**
 * Creates a fetch handler for serving hot applications.
 * @param {import("../types").ServeOptions} options
 * @returns {(req: Request, cfEnv?: Record<string, any>) => Promise<Response>} fetch handler
 */
export const serveHot = (options) => {
  const { root = "." } = options;
  const env = typeof Deno === "object" ? Deno.env.toObject() : process.env;
  const onFsNotify = fs.watch(root);
  const contentCache = new Map(); // todo: use worker `caches` api if possible
  const hotClients = new Map();

  /**
   * Fetcher handles requests for hot applications.
   * @param {Request} req - Incoming request
   * @param {Record<string, string>} cfEnv - Cloudflare env
   * @returns {Promise<Response>}
   */
  async function fetcher(req, cfEnv) {
    const url = new URL(req.url);
    const pathname = decodeURIComponent(url.pathname);

    if (cfEnv && !req.cf) {
      cfEnv = undefined;
    }

    switch (pathname) {
      /** Proxy content map requests */
      case "/@hot-content": {
        const {
          name,
          url,
          method,
          payload,
          authorization,
          headers,
          timeout,
          cacheTtl,
          select,
          stream,
          asterisk,
          vars,
        } = await req.json();
        if (!isNEString(name) || !isNEString(url)) {
          return new Response("Invalid request", { status: 400 });
        }
        const resolveEnv = (value) =>
          value.replace(
            /\$\{(.*?)\}/g,
            (_, key) => {
              key = key.trim().toLowerCase();
              if (key === "name") {
                return name;
              }
              if (key === "*") {
                return asterisk ?? "";
              }
              if (key.startsWith("env.")) {
                const { hostname } = new URL(url);
                return (cfEnv ?? env)["[" + hostname + "]" + key.slice(4)] ??
                  "";
              }
              if (key.startsWith("vars.") && vars) {
                return vars[key.slice(6)] ?? "";
              }
              return "";
            },
          );
        const u = resolveEnv(url, name);
        const m = method?.toUpperCase();
        const h = new Headers(headers);
        h.forEach((value, key) => {
          h.set(key, resolveEnv(value, name));
        });
        if (authorization) {
          h.set("authorization", resolveEnv(authorization, name));
        }
        let body;
        if (isObject(payload) || Array.isArray(payload)) {
          body = resolveEnv(JSON.stringify(payload), name);
          if (!h.has("content-type")) {
            h.set("content-type", "application/json");
          }
        } else if (payload) {
          body = resolveEnv(String(payload), name);
        }
        if (!m && body) {
          m = "POST";
        }
        const args = JSON.stringify([
          u,
          m,
          body,
          select,
          vars,
          ...h.entries(),
        ]);
        const cacheable = !stream && Number.isInteger(cacheTtl);
        if (cacheable) {
          const cached = contentCache.get(name);
          if (cached) {
            if (cached.args === args && cached.expires > Date.now()) {
              return Response.json(cached.data);
            }
            // clear cache if args changed or expired
            contentCache.delete(name);
          }
        }

        let signal = undefined;
        if (Number.isInteger(timeout) && timeout > 0) {
          const ac = new AbortController();
          setTimeout(() => ac.abort(), timeout * 1000);
          signal = ac.signal;
        }

        const res = await fetch(u, { method: m, headers: h, body, signal });
        if (!res.ok || stream) {
          const headers = new Headers();
          res.headers.forEach((value, key) => {
            if (key === "content-type" || key === "date" || key === "etag") {
              headers.set(key, value);
            }
          });
          return new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers,
          });
        }

        let data = await (isJSONResponse(res) ? res.json() : res.text());
        if (isObject(data) && isNEString(select) && select !== "*") {
          const ret = {};
          const selectors = select.split(",")
            .map((s) => s.trim()).filter(Boolean);
          for (const s of selectors) {
            let alias = s;
            let selector = s;
            if (selector.endsWith("!")) {
              selector = selector.slice(0, -1);
            }
            const i = selector.indexOf(":");
            if (i > 0) {
              alias = selector.slice(0, i).trimEnd();
              selector = selector.slice(i + 1).trimStart();
            }
            const value = lookupValue(data, resolveEnv(selector));
            if (value !== undefined) {
              ret[alias] = value;
            }
          }
          if (selectors.length === 1 && selectors[0].endsWith("!")) {
            data = Object.values(ret)[0] ?? null;
          } else {
            data = ret;
          }
        }
        if (cacheable) {
          contentCache.set(name, {
            args,
            data,
            expires: Date.now() + cacheTtl * 1000,
          });
        }
        return Response.json(data);
      }

      /** The FS index of current project */
      case "/@hot-index": {
        const entries = await fs.ls(root);
        return Response.json(entries);
      }

      /** Bundle files with glob pattern */
      case "/@hot-glob": {
        const headers = new Headers({
          "content-type": "binary/glob",
          "x-glob-index": "2",
        });
        const { pattern: glob } = await req.json();
        if (!isNEString(glob)) {
          return new Response("[]", { headers });
        }
        const entries = await fs.ls(root);
        const matched = entries.filter((entry) =>
          glob.includes(entry) || entry.match(globToRegExp(glob))
        );
        if (!matched.length) {
          return new Response("[]", { headers });
        }
        const names = enc.encode(JSON.stringify(matched) + "\n");
        const sizes = await Promise.all(matched.map(async (filename) => {
          const stat = await fs.stat(root + "/" + filename);
          return stat.size;
        }));
        headers.set("x-glob-index", [names.length, ...sizes].join(","));
        let currentFile;
        let isCancelled;
        const push = async (controller) => {
          const filename = matched.shift();
          if (!filename) {
            controller.close();
            return;
          }
          currentFile = await fs.open(root + "/" + filename);
          const reader = currentFile.body.getReader();
          const pump = async () => {
            const { done, value } = await reader.read();
            if (done) {
              currentFile.close();
              currentFile = null;
              return;
            }
            if (isCancelled) {
              return;
            }
            controller.enqueue(new Uint8Array(value));
            pump();
          };
          await pump();
        };
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(names);
            },
            async pull(controller) {
              await push(controller);
            },
            cancel() {
              currentFile?.close();
              isCancelled = true;
            },
          }),
          { headers },
        );
      }

      /** Events streaming */
      case "/@hot-events": {
        const channelName = url.searchParams.get("channel");
        const devChannel = channelName === "dev";
        const disposes = [];
        if (req.method === "POST") {
          const data = await req.json();
          const clients = hotClients.get(channelName);
          if (!clients) {
            return new Response("Channel not found", { status: 404 });
          }
          clients.forEach(({ sentEvent }) => sentEvent("message", data));
          return new Response("Ok");
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              const sentEvent = (eventName, data) => {
                controller.enqueue(
                  "event: " + eventName + "\ndata: " + JSON.stringify(data) +
                    "\n\n",
                );
              };
              controller.enqueue(": hot events stream\n\n");
              if (devChannel) {
                disposes.push(onFsNotify((type, name) => {
                  sentEvent("fs-notify", { type, name });
                }));
                if (isLocalHost(url)) {
                  sentEvent("open-devtools", null);
                }
              } else {
                const map = hotClients.get(channelName) ??
                  hotClients.set(channelName, new Map()).get(channelName);
                map.set(req, { sentEvent });
              }
            },
            cancel() {
              if (devChannel) {
                disposes.forEach((dispose) => dispose());
              } else {
                hotClients.get(channelName)?.delete(req);
              }
            },
          }),
          {
            headers: {
              "transfer-encoding": "chunked",
              "content-type": "text/event-stream",
            },
          },
        );
      }

      /** Static files */
      default: {
        let filepath = pathname;
        let file = null;
        if (pathname.includes(".")) {
          file = await fs.open(root + filepath);
        }
        if (!file) {
          switch (pathname) {
            case "/apple-touch-icon-precomposed.png":
            case "/apple-touch-icon.png":
            case "/robots.txt":
            case "/favicon.ico":
              return new Response("Not found", { status: 404 });
            case "/sw.js": {
              let hotUrl = new URL(HOT_URL);
              const v = url.searchParams.get("@hot");
              if (v) {
                hotUrl = new URL(v);
              }
              return new Response(
                `import hot from "${hotUrl.href}";hot.listen();`,
                {
                  headers: {
                    "content-type": "application/javascript; charset=utf-8",
                  },
                },
              );
            }
            default: {
              const htmls = ["/404.html", "/index.html"];
              if (pathname !== "/") {
                htmls.unshift(pathname + ".html", pathname + "/index.html");
              }
              for (const path of htmls) {
                filepath = path;
                file = await fs.open(root + filepath);
                if (file) break;
              }
            }
          }
        }
        if (!file) {
          return new Response("Not Found", { status: 404 });
        }
        const headers = new Headers({
          "transfer-encoding": "chunked",
          "content-type": file.contentType,
          "content-length": file.size.toString(),
          "cache-control": "public, max-age=0, must-revalidate",
        });
        // todo: set cache-control to `public, max-age=31536000, immutable` by checking hash in the filename
        if (file.lastModified) {
          const etag = 'W/"' + file.lastModified.toString(36) + "-" +
            file.size.toString(36) + '"';
          headers.set("etag", etag);
          const ifNoneMatch = req.headers.get("if-none-match");
          if (ifNoneMatch && ifNoneMatch === etag) {
            file.close();
            return new Response(null, { status: 304, headers });
          }
        }
        if (req.method === "HEAD") {
          file.close();
          return new Response(null, { headers });
        }
        const res = new Response(
          new ReadableStream({
            start(controller) {
              const reader = file.body.getReader();
              const pump = async () => {
                const { done, value } = await reader.read();
                if (done) {
                  controller.close();
                  file.close();
                  return;
                }
                controller.enqueue(new Uint8Array(value));
                pump();
              };
              pump();
            },
            cancel() {
              file.close();
            },
          }),
          { headers },
        );
        if (
          (filepath.endsWith(".md") || filepath.endsWith(".markdown")) &&
          url.searchParams.has("html")
        ) {
          return markdown.transform(res);
        }
        if (filepath.endsWith(".html")) {
          return serveHtml(res, cfEnv, url, filepath);
        }
        return res;
      }
    }
  }

  /**
   * rewrite html
   * @param {Response} res
   * @param {Record<string, any>} cfEnv
   * @param {URL} url
   * @param {string} filepath
   * @returns {Promise<Response>}
   */
  async function serveHtml(res, cfEnv, url, filepath) {
    const rewriter = new HTMLRewriter();

    // - wait for HTMLRewriter wasm module to be initialized
    if ("waiting" in HTMLRewriter) {
      await HTMLRewriter.waiting;
      delete HTMLRewriter.waiting;
    }

    // - inject fs-based router index
    rewriter.on("meta[name=fs-router]", {
      async element(el) {
        const content = el.getAttribute("content") ?? "./routes";
        const { pathname } = new URL(content, url.origin + filepath);
        const index = await fs.ls(root + pathname);
        el.replace(
          `<script type="applicatin/json" id="@hot/router">${
            JSON.stringify({ index })
          }</script>`,
          { html: true },
        );
      },
    });

    // - resolve external importmap/contentmap
    rewriter.on("script[type$=tmap][src]", {
      async element(el) {
        const type = el.getAttribute("type");
        const src = el.getAttribute("src");
        if (src && !/^\/|\w+:/.test(src)) {
          const { pathname } = new URL(src, url.origin + filepath);
          const file = await fs.open(root + pathname);
          if (file) {
            const text = await readTextFromStream(file.body);
            file.close();
            el.removeAttribute("src");
            el.setAttribute("data-src", src);
            el.setInnerContent(text);
            if (type === "contentmap") {
              contentMap = text;
            }
          }
        }
      },
    });

    // - check inline contentmap
    let contentMap = "";
    rewriter.on("script[type=contentmap]:not([src])", {
      text(el) {
        contentMap += el.text;
      },
    });

    // - render `use-content` if the `ssr` attribute is present
    rewriter.on("use-content[name][ssr]", {
      async element(el) {
        if (contentMap) {
          try {
            const { contents = {} } = isNEString(contentMap)
              ? (contentMap = JSON.parse(contentMap))
              : contentMap;
            const name = el.getAttribute("name");
            let content = contents[name];
            let asterisk = undefined;
            if (!content) {
              for (const k in contents) {
                const a = k.split("*");
                if (a.length === 2) {
                  const [prefix, suffix] = a;
                  if (
                    name.startsWith(prefix) &&
                    name.endsWith(suffix)
                  ) {
                    content = contents[k];
                    asterisk = name.slice(
                      prefix.length,
                      name.length - suffix.length,
                    );
                    break;
                  }
                }
              }
            }
            if (content) {
              const process = (data) => {
                if (data instanceof Error) {
                  return "<code style='color:red'>" + data.message + "</code>";
                }
                const mapExpr = el.getAttribute("map");
                let value = data;
                if (mapExpr && !isNullish(data)) {
                  if (cfEnv) {
                    value = lookupValue(data, mapExpr.trimStart().slice("this.".length));
                  } else {
                    value = new Function("return " + mapExpr).call(data);
                  }
                }
                return !isNullish(value)
                  ? value.toString?.() ?? stringify(value)
                  : "";
              };
              const render = (data) => {
                el.setInnerContent(process(data), { html: true });
                el.setAttribute("_ssr", "1");
              };
              const res = await fetcher(
                new Request(new URL("/@hot-content", url), {
                  method: "POST",
                  body: JSON.stringify({ ...content, asterisk, name }),
                }),
                cfEnv,
              );
              if (!res.ok) {
                let msg = res.statusText;
                try {
                  const text = (await res.text()).trim();
                  if (text) {
                    msg = text;
                    if (text.startsWith("{")) {
                      const { error, message } = JSON.parse(text);
                      msg = error?.message ?? message ?? msg;
                    }
                  }
                } catch (_) {}
                render(new Error(msg));
              } else {
                render(await res.json());
              }
            }
          } catch (err) {
            if (err instanceof SyntaxError) {
              console.error("[error] Invalid contentmap:", err.message);
            }
          }
        }
      },
    });

    // - fix script/link with relative path
    if (url.pathname !== "/") {
      rewriter
        .on("script[src]", {
          element(el) {
            const src = el.getAttribute("src");
            if (src && !/^\/|\w+:/.test(src)) {
              const { pathname } = new URL(src, url.origin + filepath);
              el.setAttribute("src", pathname);
            }
          },
        })
        .on("link[href]", {
          element(el) {
            const href = el.getAttribute("href");
            if (href && !/^\/|\w+:/.test(href)) {
              const { pathname } = new URL(href, url.origin + filepath);
              el.setAttribute("href", pathname);
            }
          },
        });
    }

    // - tell the client to reload the page when the html is updated (dev mode only)
    if (isLocalHost(url)) {
      rewriter.onDocument({
        end(end) {
          end.append(
            `<script type="hot/module">window.__hot_hmr_callbacks?.add("${filepath}", () => location.reload())</script>`,
            { html: true },
          );
        },
      });
    }

    // - TODO: support css hmr

    // - transform html
    return rewriter.transform(res);
  }

  return fetcher;
};
