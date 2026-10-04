/**
 * The gate's operator prompt: a rounded-border box with the classification
 * line colored green (safe), red (unsafe), or yellow (unsure or unavailable).
 * Keys: y = allow once, a = allow always, n/esc = deny.
 */

import type { Component } from "@earendil-works/pi-tui";

export type GatePromptResult = "allow-once" | "allow-always" | "deny";
export type GateClassification = "safe" | "unsafe" | "unsure";

export interface GatePromptInfo {
  tool: string;
  classification?: GateClassification;
  confidence?: number;
  reason: string;
  argsSummary: string;
}

/** The theme surface the prompt uses; pi's Theme satisfies it structurally. */
export interface PromptTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Green for safe, red for unsafe, yellow for unsure or model-unavailable. */
export function classificationColor(classification?: GateClassification): "success" | "error" | "warning" {
  if (classification === "safe") return "success";
  if (classification === "unsafe") return "error";
  return "warning";
}

/** Visible length, ignoring ANSI styling. */
function visible(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Greedy word wrap. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
    while (line.length > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export function createGatePrompt(info: GatePromptInfo) {
  return (
    _tui: unknown,
    theme: PromptTheme,
    _keybindings: unknown,
    done: (result: GatePromptResult) => void,
  ): Component => {
    const color = classificationColor(info.classification);
    const value = info.classification
      ? `${info.classification}${info.confidence !== undefined ? ` (${info.confidence.toFixed(2)})` : ""}`
      : "unavailable";
    let settled = false;
    const settle = (result: GatePromptResult) => {
      if (!settled) {
        settled = true;
        done(result);
      }
    };

    return {
      invalidate: () => {},
      handleInput: (data: string) => {
        if (data === "y") settle("allow-once");
        else if (data === "a") settle("allow-always");
        else if (data === "n" || data === "\x1b") settle("deny");
      },
      render: (width: number): string[] => {
        const inner = Math.max(20, width - 4);
        const title = ` gate › ${info.tool} `;
        const top =
          inner >= visible(title) + 2
            ? `╭─${title}${"─".repeat(inner - visible(title) - 1)}╮`
            : `╭─${title.slice(0, Math.max(1, inner - 3))}─╮`;

        const plain: string[] = [];
        const classificationPlain = `Classification: ${value}`;
        plain.push(classificationPlain);
        plain.push(`Reason: ${info.reason}`);
        for (const line of wrap(info.argsSummary, inner - 2)) plain.push(line);
        plain.push("");
        plain.push("y: allow once · a: allow always · n/esc: deny");

        const lines: string[] = [top];
        for (const text of plain) {
          const padded = text.length >= inner ? text.slice(0, inner) : text.padEnd(inner);
          if (text === classificationPlain) {
            // the classification value carries the color; the label stays plain
            lines.push(
              `│ ${padded.replace(value, theme.fg(color, theme.bold(value)))} │`,
            );
          } else if (text.startsWith("y: allow once")) {
            lines.push(`│ ${theme.fg("dim", padded)} │`);
          } else if (text.startsWith("Reason:") || info.argsSummary.includes(text) || text === "") {
            lines.push(`│ ${padded} │`);
          } else {
            lines.push(`│ ${theme.fg("dim", padded)} │`);
          }
        }
        lines.push(`╰${"─".repeat(inner + 2)}╯`);
        return lines;
      },
    };
  };
}
