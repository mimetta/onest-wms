"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  SectionLabel,
  Table,
  TableWrap,
  Td,
  Th,
} from "@/components/ui";
import {
  commitBatch,
  previewBatch,
  uploadCsv,
  type PreviewResult,
  type UploadResult,
} from "./actions";

/**
 * The AccCloud item-master importer (go-live D2).
 *
 * Three stages, deliberately separate: upload, preview, commit. The item master
 * is the thing every other record points at, so the one thing this screen must
 * never do is change it as a side effect of looking at a file.
 *
 * The group tick-list is built from the file rather than from a guessed list of
 * codes, because which groups are inventory is a question only the business can
 * answer and the answer differs per export.
 */
export function ImportClient() {
  const t = useTranslations("import");
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [committed, setCommitted] = useState<{
    created: number;
    updated: number;
    priced: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleUpload = async (form: FormData) => {
    setBusy(true);
    setError(null);
    setPreview(null);
    setCommitted(null);

    const result = await uploadCsv(form);
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ? `${t(result.error)}: ${result.detail}` : t(result.error));
      return;
    }

    setUpload(result.data!);
    setIncluded(
      new Set(result.data!.groups.filter((g) => g.included).map((g) => g.code)),
    );
  };

  const handlePreview = async () => {
    if (!upload) return;
    setBusy(true);
    setError(null);

    const result = await previewBatch(upload.batchId, [...included]);
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }
    setPreview(result.data!);
  };

  const handleCommit = async () => {
    if (!upload) return;
    setBusy(true);
    setError(null);

    const result = await commitBatch(upload.batchId);
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }
    setCommitted(result.data!);
    startTransition(() => router.refresh());
  };

  const toggle = (code: string) =>
    setIncluded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  const includedRows =
    upload?.groups.filter((g) => included.has(g.code)).reduce((n, g) => n + g.rows, 0) ??
    0;

  return (
    <div className="flex flex-col gap-4">
      {/* ---------------------------------------------------- 1. the file */}
      <Card className="flex flex-col gap-3">
        <SectionLabel>{t("step1")}</SectionLabel>
        <form
          action={handleUpload}
          className="flex flex-wrap items-center gap-3"
          key={upload?.batchId ?? "new"}
        >
          <input
            type="file"
            name="file"
            accept=".csv,text/csv"
            required
            className="border-brand-border text-brand-dark rounded-md border bg-white px-3 py-2 text-sm"
          />
          <Button type="submit" disabled={busy}>
            {t("readFile")}
          </Button>
        </form>
        <p className="text-brand-subtle text-xs">{t("readFileHint")}</p>
      </Card>

      {error && <Banner tone="bad">{error}</Banner>}

      {upload && (
        <>
          {upload.alreadyImported && (
            // Matched on content hash, not filename: the same export saved twice
            // under different names is the same import.
            <Banner tone="warn">{t("alreadyImported")}</Banner>
          )}

          {upload.unknownUoms.length > 0 && (
            <Banner tone="bad">
              {t("unknownUoms", {
                list: upload.unknownUoms.map((u) => `${u.value} (${u.rows})`).join(", "),
              })}
            </Banner>
          )}

          {/* ------------------------------------------- 2. what is stock */}
          <Card className="flex flex-col gap-3">
            <SectionLabel>{t("step2")}</SectionLabel>
            <p className="text-brand-muted text-sm">
              {t("groupsIntro", { file: upload.filename, rows: upload.rowCount })}
            </p>

            <ul className="flex flex-col gap-1">
              {upload.groups.map((g) => (
                <li key={g.code}>
                  <div className="hover:bg-brand-cream/60 flex items-center gap-3 rounded-md px-2 py-1.5">
                    <Checkbox
                      checked={included.has(g.code)}
                      onChange={() => toggle(g.code)}
                      label=""
                    />
                    <span className="text-brand-dark w-24 font-mono text-xs">
                      {g.code}
                    </span>
                    <span className="text-brand-dark min-w-0 flex-1 truncate text-sm">
                      {g.name}
                    </span>
                    <span className="tabular text-brand-muted text-sm">{g.rows}</span>
                  </div>
                </li>
              ))}
            </ul>

            <p className="text-brand-subtle text-xs">{t("groupsHint")}</p>

            <div className="flex items-center justify-between gap-3">
              <span className="text-brand-dark text-sm">
                {t("selectedRows", { rows: includedRows, total: upload.rowCount })}
              </span>
              <Button
                onClick={() => void handlePreview()}
                disabled={busy || included.size === 0}
              >
                {t("buildPreview")}
              </Button>
            </div>
          </Card>
        </>
      )}

      {/* -------------------------------------------------- 3. the diff */}
      {preview && !committed && (
        <>
          <Card className="flex flex-col gap-3">
            <SectionLabel>{t("step3")}</SectionLabel>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label={t("willCreate")} value={preview.create} tone="good" />
              <Stat label={t("willUpdate")} value={preview.update} tone="info" />
              <Stat label={t("excluded")} value={preview.excluded} />
              <Stat
                label={t("errors")}
                value={preview.error}
                tone={preview.error ? "bad" : undefined}
              />
              <Stat label={t("withCost")} value={preview.withCost} />
              <Stat label={t("asInactive")} value={preview.inactive} tone="warn" />
            </div>

            {preview.uomFrozen > 0 && (
              // The one refusal worth explaining at length: the ledger is
              // denominated in the old unit and cannot be retro-converted.
              <Banner tone="bad">{t("uomFrozen", { count: preview.uomFrozen })}</Banner>
            )}

            {preview.error > 0 && <Banner tone="warn">{t("errorsWillBeSkipped")}</Banner>}

            <div className="flex justify-end">
              <Button
                onClick={() => void handleCommit()}
                disabled={busy || preview.create + preview.update === 0}
              >
                {t("commit", { count: preview.create + preview.update })}
              </Button>
            </div>
          </Card>

          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>{t("row")}</Th>
                  <Th>{t("action")}</Th>
                  <Th>{t("sku")}</Th>
                  <Th>{t("name")}</Th>
                  <Th>{t("uom")}</Th>
                  <Th>{t("group")}</Th>
                  <Th className="text-right">{t("cost")}</Th>
                  <Th>{t("detail")}</Th>
                </tr>
              </thead>
              <tbody>
                {/* Errors first: they are the rows a human has to act on, and
                    burying them under 700 clean creates guarantees they are
                    missed. */}
                {[...preview.rows]
                  .sort((a, b) => {
                    const rank = (x: string) =>
                      x === "error" ? 0 : x === "update" ? 1 : 2;
                    return rank(a.action) - rank(b.action) || a.rowNo - b.rowNo;
                  })
                  .slice(0, 200)
                  .map((r) => (
                    <tr key={r.rowNo}>
                      <Td className="text-brand-subtle text-xs">{r.rowNo}</Td>
                      <Td>
                        <Badge
                          tone={
                            r.action === "create"
                              ? "good"
                              : r.action === "update"
                                ? "info"
                                : r.action === "error"
                                  ? "bad"
                                  : "neutral"
                          }
                        >
                          {t(`action_${r.action}`)}
                        </Badge>
                      </Td>
                      <Td className="font-mono text-xs">{r.sku}</Td>
                      <Td className="max-w-xs truncate">{r.nameTh}</Td>
                      <Td className="font-mono text-xs">{r.uomCode}</Td>
                      <Td className="font-mono text-xs">{r.groupCode}</Td>
                      <Td className="tabular text-right">
                        {r.cost === null ? (
                          <span className="text-brand-subtle">—</span>
                        ) : (
                          r.cost.toLocaleString()
                        )}
                      </Td>
                      <Td className="text-brand-muted text-xs">
                        {r.detail ?? r.changes.join(", ")}
                        {!r.isActive && r.action !== "error" && (
                          <Badge tone="warn">{t("inactive")}</Badge>
                        )}
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          </TableWrap>

          {preview.rows.length > 200 && (
            <p className="text-brand-subtle text-xs">
              {t("truncated", { shown: 200, total: preview.rows.length })}
            </p>
          )}
        </>
      )}

      {committed && (
        <Banner tone="good">
          {t("committed", {
            created: committed.created,
            updated: committed.updated,
            priced: committed.priced,
          })}
        </Banner>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "info" | "warn" | "bad";
}) {
  const colour =
    tone === "good"
      ? "text-success-fg"
      : tone === "bad"
        ? "text-destructive"
        : tone === "warn"
          ? "text-warning-text"
          : "text-brand-dark";

  return (
    <div className="flex flex-col">
      <span className="text-brand-subtle text-xs">{label}</span>
      <span className={`tabular text-xl font-semibold ${colour}`}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}
