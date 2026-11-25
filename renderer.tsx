/**
 * Hoosat Server-side Renderer
 *
 * This module provides a server-side rendering (SSR) function for rendering React JSX elements or ReactNodes
 * to a pipeable stream and sending the response to the client.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { renderToPipeableStream, renderToString  } from "react-dom/server";
import { Helmet, HelmetProvider } from "react-helmet-async";
import { replaceHeadTags } from "./seo";
import { HeadTags, HoosatResponse } from "./types";
import { ErrorHandler } from "./errors";
import { ReactElement, JSXElementConstructor } from "react";
import internal from "stream";
import React from 'react';
import { readNonceFromFile } from './nonce';
import { generateSitemap } from './sitemap';


/**
 * Represents the arguments for the Hoosat server-side renderer.
 *
 * @typedef {Object} HoosatRendererParams
 * @property {HoosatResponse} res - The server response object.
 * @property {ReactNode | JSX.Element} jsx - The JSX element or ReactNode to be rendered.
 * @property {object} [helmetContext] - The context object for helmet's <HelmetProvider>.
 * @property {boolean} [extractCSS] - Flag to indicate if CSS should be extracted from the React application.
 * @property {string} [preloadTagFolder] - The folder path for preloading tags in production mode.
 * @property {HeadTags} [headTags] - The additional head tags to be included in the rendered HTML.
 * @property {boolean} [inlineStyles] - Inline publicDir/styles.css into <head> instead of linking it,
 *   so the first render does not wait for a render-blocking stylesheet request.
 * @property {string} [acceptEncoding] - The request's Accept-Encoding header. When given, the streamed HTML
 *   is compressed with Brotli or gzip, flushing every chunk so streaming keeps working.
 */
export interface HoosatRendererParams {
  res: HoosatResponse,
  jsx: ReactElement<any, string | JSXElementConstructor<any>>,
  publicDir: string,
  headTags?: HeadTags,
  inlineStyles?: boolean,
  acceptEncoding?: string,
}

const inlineStylesCache = new Map<string, { mtimeMs: number, tag: string }>();

/**
 * Returns publicDir/styles.css as a <style> tag, cached until the file changes.
 * Returns undefined when the file does not exist, so the caller can fall back to a <link>.
 */
const readInlineStyles = (publicDir: string, nonce: string): string | undefined => {
  const file = path.join(publicDir, 'styles.css');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  const cached = inlineStylesCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.tag;
  }
  // "</style" inside the CSS would close the element early.
  const css = fs.readFileSync(file, 'utf-8').replace(/<\/style/gi, '<\\/style');
  const tag = `<style nonce="${nonce}">${css}</style>`;
  inlineStylesCache.set(file, { mtimeMs: stat.mtimeMs, tag });
  return tag;
};

/**
 * Picks the best supported compression from an Accept-Encoding header: Brotli, then gzip.
 */
export const pickEncoding = (acceptEncoding?: string): 'br' | 'gzip' | undefined => {
  const accepted = new Map<string, number>();
  for (const part of (acceptEncoding || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    accepted.set(name, q ? Number(q.slice(2)) : 1);
  }
  const allows = (name: string) => (accepted.get(name) ?? accepted.get('*') ?? 0) > 0;
  if (allows('br')) return 'br';
  if (allows('gzip')) return 'gzip';
  return undefined;
};

/**
 * Creates a compression stream that flushes after every chunk, so React's streamed HTML reaches the browser
 * as soon as it is rendered. Brotli quality 5 is fast enough for per-request compression.
 */
const createCompressor = (encoding: 'br' | 'gzip'): zlib.BrotliCompress | zlib.Gzip =>
  encoding === 'br'
    ? zlib.createBrotliCompress({
        flush: zlib.constants.BROTLI_OPERATION_FLUSH,
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
      })
    : zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH, level: 6 });

/**
 * Generates a transform stream to replace head tags using the helmet context.
 *
 * @param {HeadTags} headTags - The head tags to be replaced.
 * @param {object} helmetContext - The context object for helmet's <HelmetProvider>.
 * @returns {Promise<internal.Transform>} The transform stream to replace head tags.
 */
export const helmetStream = async (headTags: HeadTags, helmetContext: any): Promise<internal.Transform> => {
  if (helmetContext === undefined) {
    return replaceHeadTags({
      title: headTags.title,
      meta: headTags.meta,
      link: headTags.link,
      script: headTags.script,
      base: headTags.base,
      style: headTags.style,
    });
  }
  const { helmet } = helmetContext;
  
  const replaceStream = replaceHeadTags({
    title: headTags.title + helmet?.title?.toString(),
    meta: headTags.meta + helmet?.meta?.toString(),
    link: headTags.link + (helmet?.link?.toString()),
    script: headTags.script + helmet?.script?.toString(),
    base: headTags.base + helmet?.base?.toString(),
    style: headTags.style + helmet?.style?.toString(),
  });
  return replaceStream;
}


const as: { [key: string]: string } = {
  'ico': 'image',
  'jpg': 'image',
  'jpeg': 'image',
  'png': 'image',
  'gif': 'image',
  'avif': 'image',
  'svg': 'image',
  'otf': 'font',
  'ttf': 'font',
  'pdf': 'document',
  'txt': 'document',
  'csv': 'document',
  'json': 'fetch',
  'xml': 'document',
  'html': 'document',
  'xhtml': 'document',
  'js': 'script',
  'css': 'sstyle',
  'mp4': 'audio',
  'mp3': 'audo',
  'wav': 'audio',
  'doc': 'document',
  'xls': 'document',
  'pptx': 'document',
  'docx': 'document',
  'ppt': 'document',
  'zip': 'fetch', 
  'rar': 'fetch',
  'webm': 'video',
  'mkv': 'video',
  'avi': 'video',
  '': "document",
};


const getFileType = (fileName: string): string => {
  return fileName.split('.').pop()?.toLowerCase() || '';
};

/**
 * Renders a React JSX element or ReactNode to a pipeable stream and sends the response to the client.
 * This function is designed for server-side rendering (SSR) in a Hoosat application.
 *
 * @param {HoosatRenderer} params - The arguments for Hoosat server-side renderer.
 * @returns {void}
 */
export const renderer = async ({ res, jsx, publicDir, headTags, inlineStyles, acceptEncoding }: HoosatRendererParams): Promise<void> => {
  const helmetContext = {};
  const bundleFiles = fs.readdirSync(publicDir)
    .filter(file => file.startsWith('bundle.') && file.endsWith('.js'));
  const vendorFiles = fs.readdirSync(publicDir)
    .filter(file => file.startsWith('vendor.') && file.endsWith('.js'));

  const root = <React.StrictMode>
                  <HelmetProvider context={helmetContext}>
                      {jsx}
                  </HelmetProvider>
              </React.StrictMode>;
  const stringRender = renderToString(root);
  const prefetchRegex = /(?:src|href)\s*=\s*['"](?!(http:\/\/|https:\/\/|#))([^'"\s@]*\.[^'"\s@]*)['"]/g;
  let match;
  const prefetchUrlsFromRender = [];
  while ((match = prefetchRegex.exec(stringRender)) !== null) {
    if (!match[2].includes("manifest.json")) {
      prefetchUrlsFromRender.push(match[2]);
    }
  }
  const sitemapUrlRegex = /<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1/g;
  const sitemapUrlsFromRender = [];
  while ((match = sitemapUrlRegex.exec(stringRender)) !== null) {
    sitemapUrlsFromRender.push(match[2]);
  }
  generateSitemap(publicDir, sitemapUrlsFromRender);
  const nonce = readNonceFromFile();
  const preloadsFromRender = prefetchUrlsFromRender.map((url) => (`<link rel="prefetch" href="${url}" nonce="${nonce}" crossorigin />`));
  const preloadsFromBundleFiles = bundleFiles.map((preload) => (`<link rel="preload" href="/${preload}" as="${as[getFileType(preload)]}" nonce="${nonce}" crossorigin />`)) || [""];
  const preloadsFromVendorFiles = vendorFiles.map((preload) => (`<link rel="preload" href="/${preload}" as="${as[getFileType(preload)]}" nonce="${nonce}" crossorigin />`)) || [""];
  const preloads = [...preloadsFromBundleFiles, ...preloadsFromVendorFiles, ...preloadsFromRender ];
  const scriptsFromBundleFiles = bundleFiles.map((script) => (`<script type="module" src="/${script}" async></script>`) || [""]);
  const scriptsFromVendorFiles = vendorFiles.map((script) => (`<script type="module" src="/${script}" async></script>`) || [""]);
  const scripts = [...scriptsFromBundleFiles, ...scriptsFromVendorFiles];
  const stream = renderToPipeableStream(
    root,
    {
      // bootstrapModules: [...bundleFiles, ...vendorFiles],
      onShellReady: async () => {
        res.setHeader('content-type', 'text/html');
        if (helmetContext !== undefined) {
          let newTags: HeadTags = {};
          if (headTags !== undefined) {
            newTags = headTags;
          }
          const inlineStyleTag = inlineStyles ? readInlineStyles(publicDir, nonce) : undefined;
          const styleLinks = inlineStyleTag !== undefined
            ? ''
            : `<link rel="preload" href="/public/styles.css" as="style" nonce="${nonce}" crossorigin /><link rel="stylesheet" href="/public/styles.css" crossorigin />\n`;
          newTags.link = newTags.link + preloads.join("\n") + styleLinks;
          newTags.script = newTags.script + scripts.join("\n");
          if (inlineStyleTag !== undefined) {
            newTags.style = (newTags.style ?? '') + inlineStyleTag;
          }
          const replaceStream = await helmetStream(newTags, helmetContext);
          const encoding = acceptEncoding !== undefined ? pickEncoding(acceptEncoding) : undefined;
          if (encoding !== undefined) {
            res.setHeader('Content-Encoding', encoding);
            const vary = res.getHeader('Vary');
            res.setHeader('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
            const compressor = createCompressor(encoding);
            compressor.pipe(res);
            stream.pipe(replaceStream).pipe(compressor);
          } else {
            stream.pipe(replaceStream).pipe(res);
          }
        } else {
          stream.pipe(res);
        }
      },
      onShellError(error) {
        console.error(error);
        res.status(500).send("onShellError");
        ErrorHandler(error);
      },
      onError(error) {
        console.error(error);
        ErrorHandler(error);
      }
    }
  );
};
