import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import "./ModelSwitch.css";

import type { OmpModelChoice, OmpModelsResponse } from "../../shared/protocol.ts";
import { machinePath } from "../../shared/machines.ts";
import { useMachineId } from "../lib/machineContext.tsx";

export function ModelSwitch({ current, busy, onPick, onClose }: {
  current: string | null;
  busy: boolean;
  onPick: (selector: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const machineId = useMachineId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<OmpModelChoice[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    const controller = new AbortController();
    void fetch(machinePath(machineId, "omp/models"), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<OmpModelsResponse>;
      })
      .then((body) => { if (!controller.signal.aborted) setModels(body.models); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [machineId]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = models ?? [];
    if (!needle) return rows.slice(0, 80);
    return rows.filter((model) => `${model.provider} ${model.id} ${model.name} ${model.selector}`.toLowerCase().includes(needle)).slice(0, 80);
  }, [models, query]);

  return (
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal model-switch" role="dialog" aria-modal="true" aria-labelledby="model-switch-title" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
        <header className="modal-header">
          <h2 className="modal-title" id="model-switch-title">{t("Switch model")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close dialog")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <p className="model-switch-note">{t("Switches this session only")}</p>
        <input ref={inputRef} className="input" type="search" value={query} placeholder={t("Search models")} aria-label={t("Search models")} onChange={(event) => setQuery(event.target.value)} />
        {models === null && !failed && <p className="model-switch-note">{t("Loading…")}</p>}
        {failed && <p className="model-switch-note" role="alert">{t("Couldn't load models")}</p>}
        {models !== null && shown.length === 0 && <p className="model-switch-note">{t("No matching models")}</p>}
        <ul className="model-switch-list">
          {shown.map((model) => (
            <li key={model.selector}>
              <button type="button" className="model-switch-row" disabled={busy || model.selector === current} onClick={() => onPick(model.selector)}>
                <span className="model-switch-name">{model.name}</span>
                <span className="model-switch-id">{model.selector}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
