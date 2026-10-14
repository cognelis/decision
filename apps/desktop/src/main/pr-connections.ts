import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { prConnectionSchema, prConnectionInputSchema, prReviewLoadSchema, type PrConnectionInput, type PrConnection, type PrListQuery, type PrReviewDiffRequest, type PrActionRequest, type PrReviewCommentRequest, type PrGeneralCommentRequest, type PrReviewLoad } from "@cognelis/decision-protocol";
import { atomicWrite } from "./atomic-write.js";
import { CredentialVaultError, type CredentialVault } from "./model/credential-vault.js";
import { HostedPrClient, ownsWebLink } from "./pr-platform-client.js";

const stored = prConnectionSchema.extend({ credentialRef: z.string().min(1).max(200) });
const document = z.array(stored).max(20);
export class PrConnections {
  private actionPending = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string, private readonly credentials: Pick<CredentialVault, "get" | "set" | "delete">) {}
  private async read() {
    try { return document.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw new Error("代码平台链接配置无法读取；原文件已保留，请检查后重试。");
    }
  }
  async list(): Promise<PrConnection[]> { return (await this.read()).map(({ credentialRef: _, ...connection }) => connection); }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  save(input: PrConnectionInput): Promise<PrConnection[]> {
    const request = prConnectionInputSchema.parse(input);
    return this.serialize(async () => {
      const current = await this.read();
      const previous = current.find((item) => item.id === request.id);
      if (request.id && !previous) throw new Error("链接已被移除，请刷新。");
      if (!request.token && (!previous || previous.platform !== request.platform || previous.baseUrl !== request.baseUrl)) throw new Error("新建链接或更换站点时必须提供访问令牌。");
      const { token, ...fields } = request;
      const id = previous?.id ?? randomUUID();
      const credentialRef = token ? `pr-${randomUUID()}` : previous!.credentialRef;
      const next = stored.parse({ ...fields, id, credentialRef });
      const records = document.parse([...current.filter((item) => item.id !== id), next]);
      if (token) {
        await this.credentials.set(credentialRef, token).catch((error: unknown) => {
          // Refused at the keychain prompt, or no system encryption: said in English, the page sent the reader to
          // re-check an address and token with nothing wrong with them.
          if (error instanceof CredentialVaultError && error.code === "credential_unavailable") {
            throw new Error("没能把访问令牌存进系统钥匙串（可能在提示时拒绝了授权，或系统加密不可用）。可以重试并在提示时允许，或在设置里开启“本地密钥模式”后再保存。");
          }
          throw error;
        });
      }
      try { await atomicWrite(this.path, JSON.stringify(records)); }
      catch (error) { if (token) await this.credentials.delete(credentialRef).catch(() => undefined); throw error; }
      if (token && previous) await this.credentials.delete(previous.credentialRef).catch(() => undefined);
      return records.map(({ credentialRef: _, ...connection }) => connection);
    });
  }
  remove(id: string): Promise<PrConnection[]> {
    z.string().uuid().parse(id);
    return this.serialize(async () => {
      const records = await this.read();
      const previous = records.find((item) => item.id === id);
      await atomicWrite(this.path, JSON.stringify(records.filter((item) => item.id !== id)));
      if (previous) await this.credentials.delete(previous.credentialRef).catch(() => undefined);
      return records.filter((item) => item.id !== id).map(({ credentialRef: _, ...connection }) => connection);
    });
  }
  async client(id: string): Promise<HostedPrClient> {
    const record = (await this.read()).find((item) => item.id === id);
    if (!record) throw new Error("请先在设置 › 链接中添加并选择代码平台。");
    let token: string | null;
    try {
      token = await this.credentials.get(record.credentialRef);
    } catch {
      // The keychain would not give it back (refused after the app was updated or re-signed, say): shown as
      // "Credential decryption failed", nothing said what to do, and entering it again is what helps.
      throw new Error("这个链接保存的访问令牌读不出来（系统钥匙串没有交出它，常见于应用更新之后），请在设置 › 链接中重新填写令牌。");
    }
    if (!token) throw new Error("平台访问令牌不可用，请在设置 › 链接中更新。");
    const { credentialRef: _, ...connection } = record;
    return HostedPrClient.create(connection, token);
  }
  async account(id: string) { return (await this.client(z.string().uuid().parse(id))).account(); }
  async actionContext(request: PrReviewDiffRequest) { return (await this.client(request.connectionId)).actionContext(request); }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.actionPending) throw new Error("已有平台操作正在提交，请等待结果后再操作。");
    this.actionPending = true;
    try { return await operation(); }
    finally { this.actionPending = false; }
  }
  performAction(request: PrActionRequest) { return this.exclusive(async () => (await this.client(request.connectionId)).performAction(request)); }
  publishComment(request: PrReviewCommentRequest) { return this.exclusive(async () => (await this.client(request.connectionId)).publishComment(request)); }
  publishGeneralComment(request: PrGeneralCommentRequest) { return this.exclusive(async () => (await this.client(request.connectionId)).publishGeneralComment(request)); }
  /** The PR's page on its platform, built from the link's own address. */
  async prWebUrl(request: PrReviewLoad) { return (await this.client(request.connectionId)).webUrl(request.reference); }
  async pullRequests(query: PrListQuery) { return (await this.client(query.connectionId)).list(query); }
  /** The discussion already on one PR, read with that link's token: up to ten pages, newest first. */
  async discussion(request: PrReviewLoad) {
    const { connectionId, reference } = prReviewLoadSchema.parse(request);
    return (await this.client(connectionId)).commentPages(reference, 10);
  }
  /** Only a link under a connected platform opens, so a note cannot send the browser anywhere else. */
  async webLink(link: string): Promise<string> {
    const url = new URL(z.string().url().max(2_000).parse(link)).href;
    if (!(await this.list()).some((connection) => ownsWebLink(connection, url))) throw new Error("这条链接不属于已添加的代码平台链接，未打开。");
    return url;
  }
}
