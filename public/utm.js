// VR UTM Analytics & Traffic Telemetry - Client Controller
let todosOsCliques = [];
let filtroTexto = "";
let periodoAtivo = "hoje";
let autoRefreshTimer = null;

// Inicialização
document.addEventListener("DOMContentLoaded", () => {
    inicializarBuilder();
    inicializarFiltros();
    carregarDados();

    // Auto-refresh a cada 5 segundos
    autoRefreshTimer = setInterval(() => {
        carregarDados(true);
    }, 5000);
});

// Inicializa o Gerador de Links UTM
function inicializarBuilder() {
    const inputs = ["builder-url", "builder-source", "builder-medium", "builder-campaign"];
    inputs.forEach(id => {
        const elem = document.getElementById(id);
        if (elem) {
            elem.addEventListener("input", updateBuilderPreview);
        }
    });

    const btnCopiar = document.getElementById("btn-copiar-link");
    if (btnCopiar) {
        btnCopiar.addEventListener("click", copiarLinkGerado);
    }

    updateBuilderPreview();
}

function setBuilderField(field, value) {
    const input = document.getElementById(`builder-${field}`);
    if (input) {
        input.value = value;
        updateBuilderPreview();
    }
}

function updateBuilderPreview() {
    const baseUrl = (document.getElementById("builder-url")?.value || "https://supervr.shop/").trim();
    const source = (document.getElementById("builder-source")?.value || "").trim();
    const medium = (document.getElementById("builder-medium")?.value || "").trim();
    const campaign = (document.getElementById("builder-campaign")?.value || "").trim();

    try {
        let cleanBase = baseUrl.split("?")[0];
        if (!cleanBase.endsWith("/")) cleanBase += "/";
        
        const params = new URLSearchParams();
        if (source) params.set("utm_source", source);
        if (medium) params.set("utm_medium", medium);
        if (campaign) params.set("utm_campaign", campaign);

        const finalUrl = params.toString() ? `${cleanBase}?${params.toString()}` : cleanBase;
        const preview = document.getElementById("link-gerado-preview");
        if (preview) preview.textContent = finalUrl;

        const btnTestar = document.getElementById("btn-testar-link");
        if (btnTestar) btnTestar.href = finalUrl;
    } catch (e) {}
}

async function copiarLinkGerado() {
    const preview = document.getElementById("link-gerado-preview");
    const texto = preview ? preview.textContent : "";
    if (!texto) return;

    try {
        await navigator.clipboard.writeText(texto);
        mostrarToast("Link UTM copiado para a área de transferência!");
        const btnTexto = document.getElementById("btn-copiar-texto");
        if (btnTexto) {
            const original = btnTexto.textContent;
            btnTexto.textContent = "Copiado!";
            setTimeout(() => { btnTexto.textContent = original; }, 1800);
        }
    } catch (e) {
        // Fallback legado de cópia
        const tempInput = document.createElement("input");
        tempInput.value = texto;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand("copy");
        document.body.removeChild(tempInput);
        mostrarToast("Link copiado com sucesso!");
    }
}

function inicializarFiltros() {
    const seletor = document.getElementById("seletor-periodo");
    if (seletor) {
        seletor.addEventListener("change", (e) => {
            periodoAtivo = e.target.value;
            carregarDados();
        });
    }

    const inputBusca = document.getElementById("filtro-busca");
    if (inputBusca) {
        inputBusca.addEventListener("input", (e) => {
            filtroTexto = e.target.value.toLowerCase().trim();
            renderizarTabela();
        });
    }

    const btnAtualizar = document.getElementById("btn-atualizar");
    if (btnAtualizar) {
        btnAtualizar.addEventListener("click", () => {
            carregarDados();
            mostrarToast("Dados de telemetria atualizados.");
        });
    }

    const btnExportar = document.getElementById("btn-exportar-csv");
    if (btnExportar) {
        btnExportar.addEventListener("click", () => {
            window.location.href = `/api/utm/export?periodo=${encodeURIComponent(periodoAtivo)}`;
        });
    }

    const btnLimpar = document.getElementById("btn-limpar-dados");
    if (btnLimpar) {
        btnLimpar.addEventListener("click", async () => {
            if (confirm("Deseja realmente limpar todos os cliques e registros de teste de telemetria?")) {
                try {
                    const res = await fetch("/api/utm/clear", { method: "POST" });
                    if (res.ok) {
                        mostrarToast("Histórico de testes limpo com sucesso.");
                        carregarDados();
                    }
                } catch (e) {}
            }
        });
    }
}

// Busca e Atualização dos Dados
async function carregarDados(isSilent = false) {
    try {
        const [resStats, resClicks] = await Promise.all([
            fetch(`/api/utm/stats?periodo=${encodeURIComponent(periodoAtivo)}&t=${Date.now()}`),
            fetch(`/api/utm/clicks?limite=200&t=${Date.now()}`)
        ]);

        if (resStats.ok) {
            const dataStats = await resStats.json();
            if (dataStats.success && dataStats.metricas) {
                renderizarKPIs(dataStats.metricas);
                renderizarBreakdowns(dataStats.metricas);
            }
        }

        if (resClicks.ok) {
            const dataClicks = await resClicks.json();
            if (dataClicks.success && Array.isArray(dataClicks.cliques)) {
                todosOsCliques = dataClicks.cliques;
                renderizarTabela();
            }
        }
    } catch (err) {
        if (!isSilent) console.error("Erro ao carregar telemetria UTM:", err);
    }
}

function renderizarKPIs(m) {
    const kTotal = document.getElementById("kpi-total-cliques");
    const kUnicos = document.getElementById("kpi-visitantes-unicos");
    const kHoje = document.getElementById("kpi-cliques-hoje");
    const kConv = document.getElementById("kpi-conversoes");
    const kTaxa = document.getElementById("kpi-taxa-conversao");

    if (kTotal) kTotal.textContent = m.totalClicks || 0;
    if (kUnicos) kUnicos.textContent = m.uniqueVisitors || 0;
    if (kHoje) kHoje.textContent = m.todayClicks || 0;
    if (kConv) kConv.textContent = m.totalConversions || 0;
    if (kTaxa) kTaxa.textContent = m.conversionRate || "0.0%";
}

function renderizarBreakdowns(m) {
    // 1. Sources Breakdown
    const containerSources = document.getElementById("lista-sources");
    const badgeSources = document.getElementById("badge-total-sources");
    if (badgeSources) badgeSources.textContent = `${(m.sources || []).length} fontes`;

    if (containerSources) {
        if (!m.sources || m.sources.length === 0) {
            containerSources.innerHTML = `<div style="color: var(--text-dim); font-size: 12px; text-align: center; padding: 24px 0;">Nenhum clique registrado ainda.</div>`;
        } else {
            let html = "";
            m.sources.forEach(s => {
                const cor = obterCorSource(s.name);
                html += `
                    <div class="bar-row">
                        <div class="bar-label">
                            <span class="bar-name">
                                <span class="badge badge-source ${cor.classe}">${escapeHtml(s.name)}</span>
                                ${s.conversions > 0 ? `<span class="badge badge-conv">${s.conversions} login${s.conversions > 1 ? 's' : ''}</span>` : ''}
                            </span>
                            <span class="bar-count">${s.count} cliques (${s.percentage}%)</span>
                        </div>
                        <div class="progress-track">
                            <div class="progress-fill" style="width: ${Math.max(s.percentage, 4)}%; background: ${cor.hex};"></div>
                        </div>
                    </div>
                `;
            });
            containerSources.innerHTML = html;
        }
    }

    // 2. Campaigns Breakdown
    const containerCamp = document.getElementById("lista-campaigns");
    const badgeCamp = document.getElementById("badge-total-campaigns");
    if (badgeCamp) badgeCamp.textContent = `${(m.campaigns || []).length} campanhas`;

    if (containerCamp) {
        if (!m.campaigns || m.campaigns.length === 0) {
            containerCamp.innerHTML = `<div style="color: var(--text-dim); font-size: 12px; text-align: center; padding: 24px 0;">Nenhuma campanha detectada.</div>`;
        } else {
            let html = "";
            m.campaigns.forEach(c => {
                html += `
                    <div class="bar-row">
                        <div class="bar-label">
                            <span class="bar-name" style="color: #93c5fd; font-family: 'JetBrains Mono', monospace; font-size: 11px;">
                                ${escapeHtml(c.name)}
                                ${c.conversions > 0 ? `<span class="badge badge-conv" style="font-family: inherit;">${c.conversions} conv.</span>` : ''}
                            </span>
                            <span class="bar-count">${c.count} (${c.percentage}%)</span>
                        </div>
                        <div class="progress-track">
                            <div class="progress-fill" style="width: ${Math.max(c.percentage, 4)}%; background: #3b82f6;"></div>
                        </div>
                    </div>
                `;
            });
            containerCamp.innerHTML = html;
        }
    }

    // 3. Devices & Mediums Breakdown
    const containerDev = document.getElementById("lista-devices");
    if (containerDev) {
        let html = `<div style="display: flex; flex-direction: column; gap: 14px;">`;

        if (m.devices && m.devices.length > 0) {
            html += `<div><div style="font-size: 11px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; margin-bottom: 8px;">Dispositivos</div>`;
            m.devices.forEach(d => {
                html += `
                    <div class="bar-row">
                        <div class="bar-label">
                            <span class="bar-name">${escapeHtml(d.name)}</span>
                            <span class="bar-count">${d.count} (${d.percentage}%)</span>
                        </div>
                        <div class="progress-track">
                            <div class="progress-fill" style="width: ${Math.max(d.percentage, 4)}%; background: #a855f7;"></div>
                        </div>
                    </div>
                `;
            });
            html += `</div>`;
        }

        if (m.mediums && m.mediums.length > 0) {
            html += `<div style="border-top: 1px solid var(--border); padding-top: 12px;"><div style="font-size: 11px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; margin-bottom: 8px;">Mídias Principais</div>`;
            m.mediums.slice(0, 4).forEach(med => {
                html += `
                    <div class="bar-row">
                        <div class="bar-label">
                            <span class="bar-name" style="font-family: monospace; color: #a5b4fc;">${escapeHtml(med.name)}</span>
                            <span class="bar-count">${med.count} (${med.percentage}%)</span>
                        </div>
                        <div class="progress-track">
                            <div class="progress-fill" style="width: ${Math.max(med.percentage, 4)}%; background: #6366f1;"></div>
                        </div>
                    </div>
                `;
            });
            html += `</div>`;
        }

        html += `</div>`;
        containerDev.innerHTML = html;
    }
}

function renderizarTabela() {
    const corpo = document.getElementById("tabela-cliques-corpo");
    if (!corpo) return;

    let filtrados = todosOsCliques;
    if (filtroTexto) {
        filtrados = todosOsCliques.filter(c => {
            const haystack = [
                c.utm_source,
                c.utm_medium,
                c.utm_campaign,
                c.ip,
                c.device_type,
                c.browser,
                c.os,
                c.usuario_convertido
            ].join(" ").toLowerCase();
            return haystack.includes(filtroTexto);
        });
    }

    if (filtrados.length === 0) {
        corpo.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; color: var(--text-dim); padding: 36px 0;">
                    ${filtroTexto ? "Nenhum clique correspondente ao filtro pesquisado." : "Nenhum clique registrado no período selecionado."}
                </td>
            </tr>
        `;
        return;
    }

    let html = "";
    filtrados.forEach(c => {
        const cor = obterCorSource(c.utm_source);
        const iconeDev = c.device_type === "Mobile" 
            ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/></svg>`
            : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>`;

        html += `
            <tr>
                <td class="font-mono" style="color: var(--text-muted);">${escapeHtml(c.data_hora || "—")}</td>
                <td>
                    <span class="badge badge-source ${cor.classe}">
                        ${escapeHtml(c.utm_source || "direto")}
                    </span>
                </td>
                <td style="color: #a5b4fc; font-family: 'JetBrains Mono', monospace;">
                    ${escapeHtml(c.utm_medium || "—")}
                </td>
                <td style="color: #93c5fd; font-weight: 600;">
                    ${escapeHtml(c.utm_campaign || "padrao")}
                </td>
                <td>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        ${iconeDev}
                        <span>${escapeHtml(c.device_type || "Desktop")} • ${escapeHtml(c.os || "—")} (${escapeHtml(c.browser || "—")})</span>
                    </div>
                </td>
                <td>
                    <div style="display: flex; flex-direction: column;">
                        <span class="font-mono" style="color: #f4f4f5;">${escapeHtml(c.ip || "—")}</span>
                        ${c.referrer ? `<span style="font-size: 10px; color: var(--text-dim); max-width: 220px; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(c.referrer)}</span>` : ''}
                    </div>
                </td>
                <td>
                    ${c.converted_login 
                        ? `<span class="badge badge-conv"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> Login: ${escapeHtml(c.usuario_convertido || "Sim")}</span>`
                        : `<span class="badge badge-no-conv">Apenas Clique</span>`
                    }
                </td>
            </tr>
        `;
    });

    corpo.innerHTML = html;
}

function obterCorSource(source) {
    const s = String(source || "").toLowerCase();
    if (s.includes("instagram")) return { hex: "#ec4899", classe: "instagram" };
    if (s.includes("facebook") || s.includes("meta")) return { hex: "#2563eb", classe: "meta" };
    if (s.includes("whatsapp")) return { hex: "#22c55e", classe: "whatsapp" };
    if (s.includes("google")) return { hex: "#eab308", classe: "google" };
    if (s.includes("direto")) return { hex: "#71717a", classe: "direto" };
    return { hex: "#6366f1", classe: "" };
}

function mostrarToast(msg) {
    const toast = document.getElementById("toast");
    const toastMsg = document.getElementById("toast-msg");
    if (!toast || !toastMsg) return;
    toastMsg.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => {
        toast.classList.remove("show");
    }, 3200);
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
