import { useCallback, useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./alert-dialog";
import { Button } from "./button";

/**
 * `window.confirm`, as something the app can style, scroll and test.
 *
 * The native one blocks the renderer, ignores the theme, cannot show more than
 * a wall of plain text, and is a switch a browser or an Electron shell is
 * allowed to turn off — which turns "are you sure?" into a silent yes.
 */
export interface ConfirmRequest {
  readonly title: string;
  readonly description?: string;
  /** Preformatted body — a prompt preview, a list — shown under the description. */
  readonly detail?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
  readonly resolve: (confirmed: boolean) => void;
}

export function useConfirm(): {
  readonly confirm: (request: ConfirmRequest) => Promise<boolean>;
  readonly confirmDialog: ReactNode;
} {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        setPending((current) => {
          // A second ask while one is open would strand the first promise, and
          // an awaited callback that never settles is a button that stays dead.
          current?.resolve(false);
          return { ...request, resolve };
        });
      }),
    [],
  );

  const settle = useCallback((confirmed: boolean) => {
    setPending((current) => {
      current?.resolve(confirmed);
      return null;
    });
  }, []);

  const confirmDialog =
    pending === null ? null : (
      <AlertDialog
        open
        onOpenChange={(open: boolean) => {
          if (!open) settle(false);
        }}
      >
        <AlertDialogPopup data-testid="confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{pending.title}</AlertDialogTitle>
            {pending.description === undefined ? null : (
              <AlertDialogDescription>{pending.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          {pending.detail === undefined ? null : (
            <div className="max-h-64 overflow-y-auto px-6 pb-4">
              <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs text-muted-foreground">
                {pending.detail}
              </pre>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {pending.cancelLabel ?? "Cancel"}
            </AlertDialogClose>
            <Button
              variant={pending.destructive === true ? "destructive" : "default"}
              onClick={() => settle(true)}
              data-testid="confirm-dialog-accept"
            >
              {pending.confirmLabel ?? "Continue"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    );

  return { confirm, confirmDialog };
}
