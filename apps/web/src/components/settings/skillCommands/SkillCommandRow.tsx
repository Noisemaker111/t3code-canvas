"use client";

import { PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { MAX_SKILL_COMMAND_PROMPT_LENGTH } from "./skillCommandsPage.logic";

/**
 * One global skill: `/id` plus its prompt text. The id is the map key and
 * not editable in place — renaming means deleting and re-adding.
 */
export function SkillCommandRow(props: {
  readonly id: string;
  readonly prompt: string;
  readonly onSave: (nextPrompt: string) => void;
  readonly onDelete: () => void;
  /** Product-core skills cannot be deleted. */
  readonly locked?: boolean;
  readonly badge?: string;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState(props.prompt);

  const startEditing = () => {
    setDraftPrompt(props.prompt);
    setIsEditing(true);
  };

  const save = () => {
    const trimmed = draftPrompt.trim();
    if (!trimmed) return;
    props.onSave(trimmed);
    setIsEditing(false);
  };

  return (
    <div className="border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <code className="rounded bg-muted/60 px-1.5 py-0.5 text-xs text-foreground">
            /{props.id}
          </code>
          {props.badge ? (
            <span className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              {props.badge}
            </span>
          ) : null}
        </div>
        {!isEditing ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-6 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    onClick={startEditing}
                    aria-label={`Edit /${props.id}`}
                  />
                }
              >
                <PencilIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">Edit</TooltipPopup>
            </Tooltip>
            {!props.locked ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="size-6 rounded-sm p-0 text-muted-foreground hover:text-destructive"
                      onClick={props.onDelete}
                      aria-label={`Delete /${props.id}`}
                    />
                  }
                >
                  <Trash2Icon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="top">Delete</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-6 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={() => setIsEditing(false)}
            aria-label="Cancel editing"
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>

      {isEditing ? (
        <div className="mt-2 space-y-2">
          <Textarea
            value={draftPrompt}
            onChange={(event) =>
              setDraftPrompt(event.target.value.slice(0, MAX_SKILL_COMMAND_PROMPT_LENGTH))
            }
            spellCheck
            aria-label={`Skill text for /${props.id}`}
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              {draftPrompt.trim().length}/{MAX_SKILL_COMMAND_PROMPT_LENGTH}
              {" · "}
              instructions only — card text is appended as INPUT
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={draftPrompt.trim().length === 0}
              onClick={save}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
          {props.prompt}
        </p>
      )}
    </div>
  );
}
