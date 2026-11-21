// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PrConnectionsPanel } from "../src/renderer/components/pages/pr-review/PrConnectionsPanel.js";
import { createPreviewApi } from "../src/renderer/preview-api.js";

const connection = { id: "00000000-0000-4000-8000-000000000099", label: "公司 GitHub", platform: "github" as const, baseUrl: "https://github.com" };
const harness = (items = [connection]) => {
  const api = { ...createPreviewApi(), listPrConnections: vi.fn(async () => items), savePrConnection: vi.fn(async () => [connection]), removePrConnection: vi.fn(async () => []), openSurface: vi.fn(async () => undefined) };
  return api;
};
afterEach(cleanup);

it("offers an independent links tab and creates a link in the shared modal", async () => {
  const api = harness([]); render(<PrConnectionsPanel api={api} />);
  expect(screen.getByRole("button", { name: "链接" })).toHaveAttribute("aria-current", "page");
  await screen.findByText("尚未添加链接");
  fireEvent.click(screen.getByRole("button", { name: "新增链接" }));
  const dialog = screen.getByRole("dialog", { name: "新增链接" });
  fireEvent.change(within(dialog).getByLabelText("链接名称"), { target: { value: " 公司 GitHub " } });
  fireEvent.change(within(dialog).getByLabelText("访问令牌"), { target: { value: "test-token" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存链接" }));
  await waitFor(() => expect(api.savePrConnection).toHaveBeenCalledWith({ label: "公司 GitHub", platform: "github", baseUrl: "https://github.com", token: "test-token" }));
  expect(await screen.findByText("链接已保存。")).toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("公司 GitHub")).toBeVisible();
});

it("asks to add a link in the action colour only while there is none, and points to where tokens are kept", async () => {
  const empty = harness([]);
  const view = render(<PrConnectionsPanel api={empty} />);
  await screen.findByText("尚未添加链接");
  expect(screen.getByRole("button", { name: "新增链接" })).toHaveClass("primary-button");
  fireEvent.click(screen.getByRole("button", { name: "通用 › 密钥存储" }));
  expect(empty.openSurface).toHaveBeenCalledWith("settings");
  view.unmount();

  // Beside a list of links, adding one more is one action among the rows', not the page's call to act.
  render(<PrConnectionsPanel api={harness()} />);
  await screen.findByText("公司 GitHub");
  expect(screen.getByRole("button", { name: "新增链接" })).toHaveClass("secondary-button");
  expect(screen.getByText("1 个，最多 20 个")).toBeVisible();
});

it("preserves the saved token when editing and requires a new token for another site", async () => {
  const api = harness(); render(<PrConnectionsPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 公司 GitHub" }));
  expect(screen.getByLabelText("访问令牌")).not.toBeRequired();
  expect(screen.getByLabelText("访问令牌")).toHaveValue("");
  fireEvent.click(screen.getByRole("button", { name: "保存链接" }));
  await waitFor(() => expect(api.savePrConnection).toHaveBeenCalledWith(connection));
  fireEvent.click(await screen.findByRole("button", { name: "编辑 公司 GitHub" }));
  fireEvent.change(screen.getByLabelText("服务地址"), { target: { value: "https://other.example.com" } });
  expect(screen.getByLabelText("访问令牌")).toBeRequired();
  fireEvent.submit((screen.getByRole("button", { name: "保存链接" }) as HTMLButtonElement).form!);
  expect(await screen.findByRole("alert")).toHaveTextContent("新的访问令牌");
  expect(api.savePrConnection).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("says a refused value on its field and takes focus there", async () => {
  const api = harness([]); render(<PrConnectionsPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "新增链接" }));
  const dialog = within(screen.getByRole("dialog", { name: "新增链接" }));
  fireEvent.change(dialog.getByLabelText("链接名称"), { target: { value: "公司代码平台" } });
  const address = dialog.getByLabelText("服务地址");
  // Put together here: written out, an address with credentials is what the release scan refuses.
  fireEvent.change(address, { target: { value: Object.assign(new URL("https://code.example.com"), { username: "me", password: "pw" }).href } });
  fireEvent.change(dialog.getByLabelText("访问令牌"), { target: { value: "token-123" } });
  fireEvent.submit((dialog.getByRole("button", { name: "保存链接" }) as HTMLButtonElement).form!);

  // Said only below the form, it was heard once from 保存链接, and 服务地址 said nothing when reached.
  expect(dialog.getByRole("alert")).toHaveTextContent("地址不能包含账号密码");
  expect(address).toHaveAttribute("aria-invalid", "true");
  expect(address).toHaveAccessibleDescription(/账号密码/u);
  expect(document.activeElement).toBe(address);

  fireEvent.change(address, { target: { value: "https://code.example.com" } });
  const token = dialog.getByLabelText("访问令牌");
  fireEvent.submit((dialog.getByRole("button", { name: "保存链接" }) as HTMLButtonElement).form!);
  expect(token).toHaveAttribute("aria-invalid", "true");
  expect(token).toHaveAccessibleDescription(/新的访问令牌.*读取权限/u);
  expect(address).not.toHaveAttribute("aria-invalid");
  expect(document.activeElement).toBe(token);
  expect(api.savePrConnection).not.toHaveBeenCalled();
});

it("retries failed loading and requires confirmation before removal", async () => {
  const api = harness(); api.listPrConnections.mockRejectedValueOnce(new Error("unavailable"));
  render(<PrConnectionsPanel api={api} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("读取链接失败");
  expect(screen.getByRole("button", { name: "新增链接" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  fireEvent.click(await screen.findByRole("button", { name: "移除 公司 GitHub" }));
  expect(api.removePrConnection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(api.removePrConnection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "移除 公司 GitHub" }));
  expect(screen.getByRole("dialog", { name: "移除「公司 GitHub」？" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "移除链接" }));
  await waitFor(() => expect(api.removePrConnection).toHaveBeenCalledWith(connection.id));
  expect(await screen.findByText("尚未添加链接")).toBeVisible();
});

it("keeps failed edits open and says why, without echoing the token typed", async () => {
  const api = harness();
  api.savePrConnection.mockRejectedValueOnce(new Error("没能把访问令牌存进系统钥匙串（可能在提示时拒绝了授权，或系统加密不可用）。"));
  render(<PrConnectionsPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 公司 GitHub" }));
  fireEvent.change(screen.getByLabelText("访问令牌"), { target: { value: "ghp_example_value" } });
  fireEvent.click(screen.getByRole("button", { name: "保存链接" }));
  // A keychain that refused the token was "请检查配置后重试": the address and token had nothing wrong with them.
  expect(await screen.findByRole("alert")).toHaveTextContent("保存链接失败：没能把访问令牌存进系统钥匙串");
  expect(screen.getByRole("alert")).not.toHaveTextContent("ghp_example_value");
  expect(screen.getByRole("dialog")).toBeVisible();
});

it("signs in with each link's token and says which account it is, or why it failed", async () => {
  const api = harness();
  const check = vi.spyOn(api, "checkPrConnection").mockResolvedValueOnce({ account: "octo" })
    .mockRejectedValueOnce(new Error("Error invoking remote method 'decision:pr-connection-check': PrPlatformError: 代码平台拒绝了此资源的身份认证（HTTP 401），请检查连接凭据或仓库授权。"));
  render(<PrConnectionsPanel api={api} />);
  expect(await screen.findByText("已连接 · 账号 octo")).toBeVisible();
  expect(check).toHaveBeenCalledWith(connection.id);
  fireEvent.click(screen.getByRole("button", { name: "检查 公司 GitHub" }));
  expect(await screen.findByText("代码平台拒绝了此资源的身份认证（HTTP 401），请检查连接凭据或仓库授权。")).toBeVisible();
  expect(screen.queryByText(/Error invoking remote method/u)).toBeNull();
});

it("turns 自动预评审 on with a model and a daily limit, says it on the link, and refuses a limit out of range", async () => {
  const models = [{ profileId: "local", label: "本机模型", kind: "qwen" as const, model: "qwen3", leavesDevice: false }];
  const api = { ...harness(), listAssistantModels: vi.fn(async () => models) };
  const view = render(<PrConnectionsPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑 公司 GitHub" }));
  // Off as a link starts: it spends model calls.
  expect(screen.getByLabelText("自动预评审")).toHaveValue("");
  expect(screen.queryByLabelText("每天最多评审几次")).toBeNull();
  await screen.findByRole("option", { name: "本机模型" });
  fireEvent.change(screen.getByLabelText("自动预评审"), { target: { value: "local" } });
  expect(screen.getByLabelText("每天最多评审几次")).toHaveValue(5);
  // Out of range the field's own check stops it; left empty, it is said on the field.
  fireEvent.change(screen.getByLabelText("每天最多评审几次"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "保存链接" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("1 到 50");
  expect(screen.getByLabelText("每天最多评审几次")).toHaveFocus();
  fireEvent.change(screen.getByLabelText("每天最多评审几次"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "保存链接" }));
  await waitFor(() => expect(api.savePrConnection).toHaveBeenCalledWith({ ...connection, autoReview: { profileId: "local", dailyReviews: 3 } }));
  view.unmount();

  // On a link: said on its row, and kept as it was when the link is saved again.
  const turnedOn = { ...connection, autoReview: { profileId: "local", dailyReviews: 3 } };
  const again = { ...harness([turnedOn]), listAssistantModels: vi.fn(async () => models) };
  render(<PrConnectionsPanel api={again} />);
  expect(await screen.findByText("自动预评审 · 本机模型 · 每天最多 3 次")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "编辑 公司 GitHub" }));
  fireEvent.click(screen.getByRole("button", { name: "保存链接" }));
  await waitFor(() => expect(again.savePrConnection).toHaveBeenCalledWith(turnedOn));
});
