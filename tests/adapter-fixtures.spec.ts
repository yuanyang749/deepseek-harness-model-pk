import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AttachmentStore, {
  AttachmentId,
  ImageVariantId,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type ImageRequestPolicy,
  type RequestImageAttachment,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { BUILTIN_IMAGE_REQUEST_PROTOCOLS } from '../src/host/model-catalog.js'

const IMAGE_BYTES = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const IMAGE_BASE64 = Buffer.from(IMAGE_BYTES).toString('base64')
const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: IMAGE_BYTES.byteLength,
  width: 1,
  height: 1,
}

class FixtureAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 20 * 1024 * 1024,
    maxImagesPerMessage: 10,
    maxMessageImageBytes: 50 * 1024 * 1024,
    maxImagePixels: 1_000_000,
    maxImageDimension: 8192,
    mediaTypes: ['image/png'],
  }

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.resolve()
  }

  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.resolve(IMAGE_REF)
  }

  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.resolve({ ref: IMAGE_REF, data: IMAGE_BYTES })
  }

  override readImageRequest(_ref: ImageAttachmentRef, _policy: ImageRequestPolicy): Promise<RequestImageAttachment> {
    return Promise.resolve({
      variantId: ImageVariantId(`sha256:${'b'.repeat(64)}`),
      attachment: IMAGE_REF,
      data: IMAGE_BYTES,
      mediaType: 'image/png',
      bytes: IMAGE_BYTES.byteLength,
      width: 1,
      height: 1,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    })
  }
}

interface CapturedRequest {
  readonly path: string
  readonly body: Record<string, unknown>
}

const servers: Server[] = []

afterEach(async () => {
  delete process.env.MODEL_PK_FIXTURE_KEY
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })))
})

describe('DSH 0.1.1-rc.2 pi-ai wire fixtures', () => {
  it('pins the complete built-in image evidence allowlist', () => {
    expect(BUILTIN_IMAGE_REQUEST_PROTOCOLS).toEqual([
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
    ])
  })

  it.each([
    {
      protocol: 'openai-completions',
      expectedPath: '/v1/chat/completions',
      expectedContent: [
        { type: 'text', text: 'before' },
        { type: 'text', text: `Image ${IMAGE_REF.attachmentId}; request image 1x1px.` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE_BASE64}` } },
        { type: 'text', text: 'after' },
      ],
    },
    {
      protocol: 'openai-responses',
      expectedPath: '/v1/responses',
      expectedContent: [
        { type: 'input_text', text: 'before' },
        { type: 'input_text', text: `Image ${IMAGE_REF.attachmentId}; request image 1x1px.` },
        { type: 'input_image', detail: 'auto', image_url: `data:image/png;base64,${IMAGE_BASE64}` },
        { type: 'input_text', text: 'after' },
      ],
    },
    {
      protocol: 'anthropic-messages',
      expectedPath: '/v1/messages',
      expectedContent: [
        { type: 'text', text: 'before' },
        { type: 'text', text: `Image ${IMAGE_REF.attachmentId}; request image 1x1px.` },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: IMAGE_BASE64 },
        },
        { type: 'text', text: 'after', cache_control: { type: 'ephemeral' } },
      ],
    },
  ] as const)('uses the normalized request image and preserves order for $protocol', async fixture => {
    process.env.MODEL_PK_FIXTURE_KEY = 'fixture-key'
    let resolveCaptured!: (value: CapturedRequest) => void
    const captured = new Promise<CapturedRequest>(resolve => { resolveCaptured = resolve })
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        resolveCaptured({
          path: request.url ?? '',
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        })
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"fixture complete"}}')
      })
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server did not bind TCP')
    const baseURL = `http://127.0.0.1:${address.port}${fixture.protocol === 'anthropic-messages' ? '' : '/v1'}`

    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, {
        providers: {
          fixture: {
            apiKeyEnv: 'MODEL_PK_FIXTURE_KEY',
            api: fixture.protocol,
            baseURL,
            models: [{
              id: 'fixture-vision',
              input: ['text', 'image'],
              contextWindow: 65_536,
              maxTokens: 8192,
            }],
          },
        },
      })
      await ctx.plugin(FixtureAttachmentStore)
      for await (const _chunk of ctx.llm.stream({
        provider: 'fixture',
        model: 'fixture-vision',
        maxTokens: 8192,
        system: 'frozen system prompt',
        messages: [createUserMessage({
          content: [
            { type: 'text', text: 'before' },
            { type: 'image', attachment: IMAGE_REF },
            { type: 'text', text: 'after' },
          ],
          source: { kind: 'plugin', plugin: 'dsh-model-pk' },
        })],
      })) {
        // The 401 response terminates the stream after the wire body is captured.
      }
      const request = await captured
      expect(request.path).toBe(fixture.expectedPath)
      expect(userContent(request.body, fixture.protocol)).toEqual(fixture.expectedContent)
      expect(JSON.stringify(request.body).match(new RegExp(IMAGE_BASE64, 'gu'))).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

function userContent(body: Record<string, unknown>, protocol: string): unknown {
  const collection = protocol === 'openai-responses' ? body.input : body.messages
  if (!Array.isArray(collection)) throw new Error(`missing message collection for ${protocol}`)
  const user = collection.find(item => isRecord(item) && item.role === 'user')
  if (!isRecord(user)) throw new Error(`missing user message for ${protocol}`)
  return user.content
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
