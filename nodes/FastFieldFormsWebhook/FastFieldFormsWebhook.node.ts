import type {
  IDataObject,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
} from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";
import type { IncomingHttpHeaders } from "http";
import { Readable } from "stream";

type ParsedPart = {
  headers: Record<string, string>;
  name: string;
  filename?: string;
  contentType?: string;
  body: Buffer;
};

type ResponseMode = "onReceived";

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function parseBoundary(contentType: string): string {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = (match?.[1] ?? match?.[2] ?? "").trim();

  if (!boundary) {
    throw new Error(
      `Missing multipart boundary in Content-Type: ${contentType}`,
    );
  }

  return boundary;
}

function parseHeaderBlock(buffer: Buffer): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = buffer.toString("latin1").split("\r\n");

  for (const line of lines) {
    const index = line.indexOf(":");
    if (index === -1) continue;

    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[key] = value;
  }

  return headers;
}

function unquote(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

function parseContentDisposition(value: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const segment of value.split(";")) {
    const trimmed = segment.trim();
    const index = trimmed.indexOf("=");
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim().toLowerCase();
    const val = unquote(trimmed.slice(index + 1));
    result[key] = val;
  }

  return result;
}

function findPartEnd(raw: Buffer, boundary: Buffer, from: number): number {
  const normal = Buffer.concat([Buffer.from("\r\n", "latin1"), boundary]);
  const normalIndex = raw.indexOf(normal, from);

  if (normalIndex !== -1) return normalIndex;

  return raw.indexOf(boundary, from);
}

function parseMultipart(raw: Buffer, boundaryValue: string): ParsedPart[] {
  const boundary = Buffer.from(`--${boundaryValue}`, "latin1");
  const crlf = Buffer.from("\r\n", "latin1");
  const headerSeparator = Buffer.from("\r\n\r\n", "latin1");
  const parts: ParsedPart[] = [];

  let cursor = 0;
  let unnamedIndex = 0;

  while (true) {
    const boundaryStart = raw.indexOf(boundary, cursor);
    if (boundaryStart === -1) break;

    let position = boundaryStart + boundary.length;

    if (raw.slice(position, position + 2).equals(Buffer.from("--", "latin1"))) {
      break;
    }

    if (raw.slice(position, position + 2).equals(crlf)) {
      position += 2;
    }

    const headerEnd = raw.indexOf(headerSeparator, position);
    if (headerEnd === -1) break;

    const headers = parseHeaderBlock(raw.slice(position, headerEnd));
    const disposition = parseContentDisposition(
      headers["content-disposition"] ?? "",
    );

    const bodyStart = headerEnd + headerSeparator.length;
    const bodyEnd = findPartEnd(raw, boundary, bodyStart);

    if (bodyEnd === -1) break;

    parts.push({
      headers,
      name: disposition.name ?? `part_${unnamedIndex++}`,
      filename: disposition.filename,
      contentType: headers["content-type"],
      body: raw.slice(bodyStart, bodyEnd),
    });

    cursor = bodyEnd + 2;
  }

  return parts;
}

async function streamToBuffer(
  stream: Readable,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > maxBytes) {
      throw new Error(`Request body exceeds max size of ${maxBytes} bytes`);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function parseForceBinaryFields(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((field) => field.trim())
      .filter(Boolean),
  );
}

function uniqueBinaryKey(
  binary: NonNullable<INodeExecutionData["binary"]>,
  base: string,
): string {
  let key = base || "data";
  let index = 1;

  while (binary[key]) {
    key = `${base || "data"}_${index}`;
    index += 1;
  }

  return key;
}

function normalizeExtension(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "zip";

  return trimmed.replace(/^\.+/, "") || "zip";
}

function extensionFromFileName(fileName: string): string {
  const normalized = fileName.trim();
  const index = normalized.lastIndexOf(".");

  if (index <= 0 || index === normalized.length - 1) return "";

  return normalizeExtension(normalized.slice(index + 1));
}

export class FastFieldFormsWebhook implements INodeType {
  description: INodeTypeDescription = {
    displayName: "FastField Forms Webhook",
    name: "fastFieldFormsWebhook",
    icon: "file:logo.svg",
    group: ["trigger"],
    version: 1,
    description:
      "Starts the workflow from multipart/form-data while preserving binary parts without per-part Content-Type",
    defaults: {
      name: "FastField Forms Webhook",
    },
    inputs: [],
    outputs: ["main"],
    webhooks: [
      {
        name: "default",
        httpMethod: "POST",
        responseMode: "onReceived",
        responseBody: "ok",
        responseCode: "={{ 200 }}",
        path: '={{$parameter["path"]}}',
        forceBinaryFields: "file",
      },
    ],
    properties: [
      {
        displayName: "Path",
        name: "path",
        type: "string",
        default: "/fff",
        placeholder: "fastfield-upload",
        required: true,
        description: "Webhook path to listen on",
      },
      {
        displayName: "Max Body Size (MB)",
        name: "maxBodyMb",
        type: "number",
        default: 50,
        typeOptions: {
          minValue: 1,
        },
      },
      {
        displayName: "Output Binary Filename",
        name: "binaryFileName",
        type: "string",
        default: "",
        placeholder: "upload.bin",
        description:
          "Optional fixed filename for output binary data. If empty, uses multipart filename or generated fallback",
      },
      {
        displayName: "Output Binary Mime Type",
        name: "binaryMimeType",
        type: "string",
        default: "zip",
        placeholder: "application/x-zip-compressed",
        description:
          "Optional fixed mime type for output binary data. If empty, uses multipart content type or application/x-zip-compressed",
      },
      {
        displayName: "File Extension",
        name: "fileExtension",
        type: "string",
        default: "zip",
        placeholder: "zip",
        description:
          "Extension used when generating a fallback binary filename (without leading dot)",
      },
      {
        displayName: "Options",
        name: "options",
        type: "hidden",
        default: {
          binaryData: true,
        },
      },
    ],
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const req = this.getRequestObject();
    const contentType = headerValue(req.headers, "content-type");
    const responseMode = this.getNodeParameter(
      "responseMode",
      "onReceived",
    ) as ResponseMode;
    const responseBody = this.getNodeParameter("responseBody", "OK") as string;
    const forceBinaryFields = parseForceBinaryFields(
      this.getNodeParameter("forceBinaryFields", "file") as string,
    );
    const maxBodyMb = this.getNodeParameter("maxBodyMb", 50) as number;
    const binaryFileName = (
      this.getNodeParameter("binaryFileName", "") as string
    ).trim();
    const binaryMimeType = (
      this.getNodeParameter("binaryMimeType", "") as string
    ).trim();
    const fileExtension = normalizeExtension(
      this.getNodeParameter("fileExtension", "zip") as string,
    );
    const maxBytes = Math.floor(maxBodyMb * 1024 * 1024);

    try {
      if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
        throw new Error(
          `Expected multipart/form-data but received: ${contentType || "(empty)"}`,
        );
      }

      const boundary = parseBoundary(contentType);
      const raw = await streamToBuffer(req as unknown as Readable, maxBytes);
      const parts = parseMultipart(raw, boundary);

      const item: INodeExecutionData = {
        json: {
          headers: req.headers as IDataObject,
          params: req.params as IDataObject,
          query: req.query as IDataObject,
          body: {},
          _rawMultipart: {
            partCount: parts.length,
            contentLength: headerValue(req.headers, "content-length"),
          },
        },
        binary: {},
      };

      for (const part of parts) {
        const shouldBeBinary =
          Boolean(part.filename) ||
          Boolean(part.contentType) ||
          forceBinaryFields.has(part.name);

        if (shouldBeBinary) {
          const key = uniqueBinaryKey(item.binary!, part.name);
          const resolvedFileName =
            binaryFileName || part.filename || `${key}.${fileExtension}`;
          const resolvedFileExtension =
            extensionFromFileName(resolvedFileName) || fileExtension;

          item.binary![key] = {
            data: part.body.toString("base64"),
            fileName: resolvedFileName,
            mimeType:
              binaryMimeType || part.contentType || "application/octet-stream",
            fileExtension: resolvedFileExtension,
          };
        } else {
          (item.json.body as IDataObject)[part.name] =
            part.body.toString("utf8");
        }
      }

      if (Object.keys(item.binary ?? {}).length === 0) {
        delete item.binary;
      }

      return {
        webhookResponse:
          responseMode === "onReceived" ? responseBody : undefined,
        workflowData: [[item]],
      };
    } catch (error) {
      throw new NodeOperationError(this.getNode(), error as Error);
    }
  }
}
