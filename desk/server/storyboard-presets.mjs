import { readdir } from "node:fs/promises";
import { projectFile, readJson, writeJson } from "../../scripts/lib/storage.mjs";
import { withLock, updateStatus } from "./projects.mjs";
import { badRequest } from "./errors.mjs";

const roundsOf = async (id) => (await readdir(projectFile(id, "storyboard")).catch(() => [])).filter((round) => /^r[1-9]\d*$/.test(round)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const readPreset = async (id, round) => {
  if (!/^r[1-9]\d*$/.test(round)) throw badRequest("无效方案");
  const selection = await readJson(projectFile(id, "storyboard", round, "selection.json"));
  if (selection.state !== "confirmed" || !selection.option) throw badRequest("只能复用已确认方案");
  const option = selection.draftOption ?? await readJson(projectFile(id, "storyboard", round, `${selection.option}.json`));
  return { selection, option };
};
export async function listStoryboardPresets(id) {
  const result = [];
  for (const round of await roundsOf(id)) {
    const selection = await readJson(projectFile(id, "storyboard", round, "selection.json"), null);
    if (selection?.state !== "confirmed" || !selection.option) continue;
    const { option } = await readPreset(id, round);
    result.push({ round, name: option.title, style: selection.style ?? option.style, confirmedAt: selection.confirmedAt });
  }
  return result.reverse();
}

export const createStoryboardPreset = (id, body) => withLock(id, async () => {
  const name = String(body.name ?? "").trim();
  if (!name || name.length > 80) throw badRequest("请输入方案名称（不超过 80 字）");
  const rounds = await roundsOf(id);
  const round = `r${rounds.length ? Number(rounds.at(-1).slice(1)) + 1 : 1}`;
  const beats = await readJson(projectFile(id, "analysis/beats.json"));
  const preset = body.sourceRound ? await readPreset(id, body.sourceRound) : null;
  const current = await readJson(projectFile(id, "mix/current.json"), null);
  const option = { id: "option-a", round, title: name, style: preset?.selection.style ?? preset?.option.style ?? "clean-pink@1", summary: preset ? `复用“${preset.option.title}”的视觉设置，应用于当前镜头组合。` : "新建自定义方案，使用当前镜头组合，自由设置字幕、达人和效果。", rows: beats.beats.map((beat) => ({ beat: beat.id, keep: true, cards: preset?.option.rows.find((row) => row.beat === beat.id)?.cards ?? [], onScreen: "当前镜头组合" })), global: preset?.option.global ?? [], keyframes: [], createdBy: "user" };
  let videoSettings = preset?.selection.videoSettings;
  let inherited = null;
  if (preset) {
    let plan = await readJson(projectFile(id, "edit-plan.json"), null);
    if (plan?.meta?.storyboard?.round !== body.sourceRound) {
      const names = (await readdir(projectFile(id, "versions")).catch(() => [])).filter((file) => /^edit-plan\.r\d+\.json$/.test(file)).sort().reverse();
      plan = null;
      for (const file of names) { const candidate = await readJson(projectFile(id, "versions", file)); if (candidate.meta?.storyboard?.round === body.sourceRound) { plan = candidate; break; } }
    }
    if (plan) {
      const presenter = plan.overlays?.find((item) => item.id === "mix-presenter")?.props;
      inherited = { style: plan.meta.storyboard.style, captions: plan.captions, theme: plan.theme, layout: plan.layout, presenter };
      videoSettings = { captions: plan.captions ? { enabled: true, fontSize: plan.captions.fontSize, color: plan.captions.color, activeColor: plan.captions.activeColor, background: plan.captions.background ?? null, box: plan.captions.box } : { enabled: false }, presenter: presenter ? { enabled: true, box: { x: presenter.x, y: presenter.y, width: presenter.width, height: presenter.height } } : { enabled: false } };
    }
  }
  await writeJson(projectFile(id, "storyboard", round, "option-a.json"), option);
  await writeJson(projectFile(id, "storyboard", round, "selection.json"), { round, option: "option-a", state: "draft", style: null, layoutOverrides: preset?.selection.layoutOverrides ?? {}, draftOption: null, transitions: preset?.selection.transitions ?? {}, videoSettings, confirmedAt: null });
  if (current) {
    const snapshot = { ...current, round, inherited };
    await writeJson(projectFile(id, "storyboard", round, "mix.json"), snapshot);
    await writeJson(projectFile(id, "mix/current.json"), snapshot);
  }
  await updateStatus(id, (status) => { status.stage = "storyboard"; status.stages.storyboard = { state: "waiting-user", round }; });
  return { round };
});
