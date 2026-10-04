import { useEffect, useRef, useState } from "react";
import { useDataProvider, useRefresh } from "ra-core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ImportableResource } from "./types";
import {
  commitContactPlan,
  MAX_REVIEW_BYTES,
  parseContactCsv,
  planContactImport,
  readContactSnapshot,
  type ReviewRow,
  type RowOutcome,
} from "./contactReview";

export function ContactReviewDialog({
  open,
  resource,
  onClose,
  onBusyChange,
}: {
  open: boolean;
  resource: ImportableResource;
  onClose(): void;
  onBusyChange(value: boolean): void;
}) {
  const provider = useDataProvider();
  const refresh = useRefresh();
  const [plan, setPlan] = useState<ReviewRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [outcomes, setOutcomes] = useState<RowOutcome[]>([]);
  const [phase, setPhase] = useState<
    "file" | "reading" | "review" | "writing" | "done"
  >("file");
  const [error, setError] = useState("");
  const generation = useRef(0);
  const running = useRef(false);
  const stop = useRef(false);
  const busy = phase === "reading" || phase === "writing";
  useEffect(() => {
    generation.current++;
    setPlan([]);
    setSelected(new Set());
    setOutcomes([]);
    setError("");
    setPhase("file");
  }, [open]);
  useEffect(() => {
    if (!busy) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [busy]);

  async function preview(file?: File) {
    if (!file || running.current) return;
    const version = ++generation.current;
    running.current = true;
    onBusyChange(true);
    setPhase("reading");
    setError("");
    setPlan([]);
    setOutcomes([]);
    try {
      if (file.size > MAX_REVIEW_BYTES)
        throw new Error("Review supports CSV files up to 1 MB.");
      const rows = parseContactCsv(await file.text());
      const snapshot = await readContactSnapshot(provider);
      if (version !== generation.current) return;
      const next = planContactImport(rows, snapshot);
      setPlan(next);
      setSelected(
        new Set(
          next.filter((row) => row.status === "new").map((row) => row.row),
        ),
      );
      setPhase("review");
    } catch (e) {
      if (version === generation.current) {
        setError(
          e instanceof Error
            ? e.message
            : "Preview failed. No writes attempted.",
        );
        setPhase("file");
      }
    } finally {
      running.current = false;
      onBusyChange(false);
    }
  }

  async function confirm() {
    if (running.current || phase !== "review" || !selected.size) return;
    running.current = true;
    stop.current = false;
    onBusyChange(true);
    setPhase("writing");
    setError("");
    try {
      const snapshot = await readContactSnapshot(provider);
      const fresh = planContactImport(
        plan.map((row) => row.data),
        snapshot,
      );
      await commitContactPlan(
        plan,
        fresh,
        selected,
        resource.processBatch,
        (result) => setOutcomes((current) => [...current, result]),
        () => stop.current,
      );
      setPhase("done");
      refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Recheck failed. No writes attempted.",
      );
      setPhase("review");
    } finally {
      running.current = false;
      onBusyChange(false);
    }
  }

  function downloadResults() {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              scope:
                "Contact CSV review; provider results, no transaction guarantee",
              results: outcomes,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "contact-import-results.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !running.current) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Review contact CSV</DialogTitle>
          <DialogDescription>
            Preview before creating contacts. Existing records are never updated
            or merged. This checks emails visible to your account; it is not a
            database uniqueness guarantee.
          </DialogDescription>
        </DialogHeader>
        {phase !== "writing" && phase !== "done" && (
          <div className="space-y-3">
            <label className="block font-medium" htmlFor="contact-review-file">
              Contact CSV (up to 500 records / 1 MB)
            </label>
            <input
              id="contact-review-file"
              className="block w-full rounded border p-2"
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(event) => {
                void preview(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <a
              className="underline"
              href={`data:text/csv;charset=utf-8,${encodeURIComponent(resource.sampleCsv)}`}
              download="contacts-template.csv"
            >
              Download contact template
            </a>
          </div>
        )}
        <div role="status" aria-live="polite">
          {phase === "reading"
            ? "Reading CSV and contacts. No writes are being made."
            : phase === "writing"
              ? `Import in progress: ${outcomes.length} / ${plan.length} records processed.`
              : phase === "done"
                ? `Finished: ${outcomes.filter((row) => row.status === "created").length} created, ${outcomes.filter((row) => row.status === "skipped").length} skipped, ${outcomes.filter((row) => ["failed", "unconfirmed"].includes(row.status)).length} need checking.`
                : plan.length
                  ? `${plan.length} records reviewed; ${selected.size} selected to create. No writes yet.`
                  : "Choose a file to start a read-only preview."}
        </div>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {!!plan.length && (
          <div className="max-h-[45vh] overflow-auto rounded border">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Contact import review and row results
              </caption>
              <thead>
                <tr>
                  <th className="p-2">Create</th>
                  <th className="p-2">CSV record</th>
                  <th className="p-2">Contact</th>
                  <th className="p-2">Review / result</th>
                </tr>
              </thead>
              <tbody>
                {plan.map((row) => {
                  const outcome = outcomes.find((item) => item.row === row.row);
                  return (
                    <tr key={row.row} className="border-t align-top">
                      <td className="p-2">
                        <input
                          type="checkbox"
                          aria-label={`Create record ${row.row}`}
                          checked={selected.has(row.row)}
                          disabled={phase !== "review" || row.status !== "new"}
                          onChange={(event) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(row.row);
                              else next.delete(row.row);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td className="p-2">{row.row}</td>
                      <td className="p-2 break-all">
                        {String(row.data.first_name ?? "")}{" "}
                        {String(row.data.last_name ?? "")}
                        <br />
                        {String(
                          row.data.email_work ||
                            row.data.email_home ||
                            row.data.email_other ||
                            "No email",
                        )}
                        <details>
                          <summary>Normalized fields</summary>
                          <pre className="whitespace-pre-wrap break-all">
                            {JSON.stringify(row.data, null, 2)}
                          </pre>
                        </details>
                      </td>
                      <td className="p-2">
                        <strong>{outcome?.status ?? row.status}</strong>
                        <p>{outcome?.message ?? row.reasons.join(" ")}</p>
                        {!!row.matchingIds.length && (
                          <small>
                            Matching IDs: {row.matchingIds.join(", ")}
                          </small>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          Confirmation rechecks contacts, then creates selected rows one by one.
          Other users may still write concurrently. A failed contact can leave
          related company/tag records; inspect CRM before retrying.
        </p>
        <div className="flex flex-wrap gap-2">
          {phase === "review" && (
            <Button disabled={!selected.size} onClick={() => void confirm()}>
              Create {selected.size} selected contacts
            </Button>
          )}
          {phase === "writing" && (
            <Button
              variant="outline"
              onClick={() => {
                stop.current = true;
              }}
            >
              Stop after current record
            </Button>
          )}
          {phase === "done" && (
            <Button variant="outline" onClick={downloadResults}>
              Download row results
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {phase === "done" ? "Close" : "Cancel — no writes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
