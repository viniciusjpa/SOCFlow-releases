// ==UserScript==
// @name         SOCFlow
// @namespace    somesso.socflow
// @version      0.2.0
// @description  Automação de rotinas no SOC (Pesquisa Avançada, Ficha Clínica, ASO, assinatura de PDFs)
// @author       Vinicius Farias Freitas
// @homepageURL  https://github.com/viniciusjpa/SOCFlow-releases
// @supportURL   https://github.com/viniciusjpa/SOCFlow-releases/issues
// @match        https://sistema.soc.com.br/WebSoc/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://github.com/viniciusjpa/SOCFlow-releases/raw/refs/heads/main/socflow.user.js
// @downloadURL  https://github.com/viniciusjpa/SOCFlow-releases/raw/refs/heads/main/socflow.user.js
// ==/UserScript==
// Links de atualização PROVISÓRIOS: crie o repositório público e ajuste-os se o nome mudar.
// A cada alteração, aumente o @version (o Tampermonkey só atualiza para versão maior).

(function () {
  'use strict';

  // Lida do cabeçalho "@version" pelo Tampermonkey.
  const VERSAO = typeof GM_info !== 'undefined' ? GM_info.script.version : '?';
  const REPO = 'https://github.com/viniciusjpa/SOCFlow-releases';
  const INSTALAR = REPO + '/raw/refs/heads/main/socflow.user.js';

  // ===================== CONFIG (edite aqui) =====================
  const CONFIG = {
    pesquisa: {
      socnetMarcado: false,   // checkbox SOCNET marcado por padrão?
      padrao: 'Nome',         // 'Nome' ou 'CPF'
    },
    aso: {
      // Parecer: escolhe automaticamente "APTO" ou "APTO PARA FUNÇÃO" (o que a empresa oferecer).
      // true = abre a impressão sozinho após gravar. Exige permitir pop-ups de
      // sistema.soc.com.br no Chrome; com false, aperte F8 de novo para imprimir.
      imprimirAutomatico: false,
    },
    assinatura: {
      operador: 'VINICIUS FARIAS FREITAS',
      // Vazio = primeiro certificado com o nome do operador. Para fixar outro, coloque
      // o início do código (thumbprint) dele, ex.: '44DCB5E8BE'.
      certificado: '',
    },
    ficha: {
      // F7 abre a edição e preenche o que estiver vazio (nunca altera o já respondido).
      // SOCNET: cada empresa tem formulário próprio, então só as empresas listadas aqui
      // (código da empresa, visto ao lado do nome na barra do topo) são preenchidas:
      // "Normal"/"Negativo" na seção EXAME FÍSICO + 1ª opção de CONDUTA GERAL.
      socnet: {
        '488207': { // SBF COMERCIO DE PRODUTOS ESPORTIVOS
          ignorarExames: ['OTONEUROLÓGICO'], // exames (título contém) que ficam sem mexer
          condutaPrimeiraOpcao: true,
        },
      },
      // Padrão (não SOCNET): anamnese abaixo (se vazia) e questionário normal/nega,
      // com estas respostas fixas por pergunta (início do texto da pergunta -> opção):
      respostas: {
        'Refeições regulares': 'Sim',
        'Varizes': 'Não',
      },
      anamnesePadrao: [
        'Paciente sem queixa no momento. Nega problemas de coluna.',
        'Nega doenças crônicas. Uso de medicamentos contínuos: não',
        'Cirurgias prévias: nega',
        'DUM ',
        'Alergias: não.',
        'Nega Uso de lentes corretivas. Prática de atividade física regular: nega',
        'Tabagista: não. Etilismo: social',
      ].join('\n'),
      // Homem: remove a frase/linha que começa com "DUM".
      // Demissional: remove frases/linhas que contenham estes termos (mesmo que alteradas):
      anamneseRemoverDemissional: ['Alergi', 'Lentes corretivas', 'Atividade física', 'Tabag', 'Etilis'],
    },
    timeoutMs: 60000,        // espera máxima por elementos (PDF/SOCGED pode demorar)
  };
  // ===============================================================

  const LOG = '[SOCFlow]';
  const log = (...a) => console.log(LOG, ...a);

  // ---------- helpers ----------
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();

  /** Espera até fn() retornar algo truthy; rejeita após timeout. */
  function waitFor(fn, desc, timeout = CONFIG.timeoutMs) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function tick() {
        let v;
        try { v = fn(); } catch (_) { /* ignora */ }
        if (v) return resolve(v);
        if (Date.now() - t0 > timeout) return reject(new Error('Tempo esgotado esperando: ' + desc));
        setTimeout(tick, 250);
      })();
    });
  }

  function toast(msg, isError = false) {
    const doc = window.top.document;
    const el = doc.createElement('div');
    el.textContent = 'SOCFlow: ' + msg;
    el.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:10px 14px;border-radius:6px;' +
      'font:13px sans-serif;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);background:' + (isError ? '#c62828' : '#2e7d32');
    doc.body.appendChild(el);
    setTimeout(() => el.remove(), isError ? 8000 : 3000);
    (isError ? console.error : console.log)(LOG, msg);
  }

  // Passo pendente entre recarregamentos do frame (alterar/gravar recarregam a página).
  // Expira em 30 s para que uma ação que falhou não dispare nada na próxima tela/paciente.
  const passo = {
    marcar: (chave, valor) => sessionStorage.setItem(chave, JSON.stringify({ valor, t: Date.now() })),
    consumir: (chave) => {
      const raw = sessionStorage.getItem(chave);
      sessionStorage.removeItem(chave);
      try { const p = JSON.parse(raw); return p && Date.now() - p.t < 30000 ? p.valor : null; } catch (_) { return null; }
    },
  };

  async function run(name, fn) {
    try { await fn(); } catch (e) { toast(name + ': ' + e.message, true); }
  }

  // ---------- detecção de página (por frame) ----------
  // O programa vem na query (pesqRapida) ou num <input type=hidden name=codPrg> (cad017.do etc).
  // ASO Rápido (264) e Impressão ASO usam o mesmo cad017.do: a impressão abre como aba própria (top).
  const path = location.pathname;
  const codPrg = new URLSearchParams(location.search).get('codPrg') ||
    (document.querySelector('input[name=codPrg]') || {}).value;
  const isTop = window.top === window;
  const page =
    path.includes('pesqRapida') && codPrg === '088' ? 'pesquisa' :
    path.includes('cad017.do') && isTop ? 'impressaoAso' :
    path.includes('cad017.do') && codPrg === '264' ? 'aso' :
    // Ficha Clínica (229): codPrg vem vazio ou herdado da tela anterior (ex.: 264) — vale o path.
    path.includes('cad009.do') ? 'ficha' :
    path.includes('imprimirTodosProntuarios') ? 'prontuarios' :
    null;

  /** Link <a href="javascript:doAcao('x')"> visível. */
  const acao = (x) => [...document.querySelectorAll('a[href^="javascript:doAcao"]')]
    .find((a) => a.getAttribute('href').includes(`doAcao('${x}')`) && visible(a));

  // ---------- 088 Pesquisa Avançada ----------
  function initPesquisa() {
    const $id = (id) => document.getElementById(id);
    const radio = $id('buscaFuncionario_0'); // "Funcionário"
    if (!radio) return;
    const nome = $id('nomeFuncionario');
    if (!radio.checked) radio.click(); // libera campos (handler jQuery 'change')
    // Padrões só na tela vazia: após uma busca a página recarrega e mantém o que o usuário escolheu.
    if (!nome.value) {
      window.pesquisaAvancada.todos(); // marca ativo/inativo/pendente/afastado/férias
      $id('acessoSocnet').checked = CONFIG.pesquisa.socnetMarcado;
      const sel = $id('tipoPesquisaFuncionario');
      const opt = [...sel.options].find((o) => norm(o.text) === norm(CONFIG.pesquisa.padrao));
      if (opt) sel.value = opt.value;
    }
    // ENTER no campo nome/CPF dispara a busca (lupa "Localizar" = doAcao('browse')).
    // Captura no document para rodar antes do keydown próprio (jQuery) do campo.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target !== nome || !nome.value.trim()) return;
      e.preventDefault(); e.stopPropagation();
      acao('browse').click();
    }, true);
    nome.focus();
    log('088 pronto');
  }

  // ---------- assinatura digital (compartilhado: Impressão ASO e Prontuários) ----------
  /** Botão do wizard de assinatura (div/p .botaoInstalacao) visível com texto exato. */
  const botaoWizard = (texto) => [...document.querySelectorAll('.botaoInstalacao')]
    .find((e) => visible(e) && norm(e.innerText) === norm(texto));

  /**
   * Abre o assistente de assinatura (botão "Capturar biometria, criar pdf e assinar digitalmente",
   * #processoCompletoAssinar — o mesmo na Impressão ASO e nos Prontuários). Atenção: o link
   * vizinho capturaBiometriaDesktop() (5px) abre a "Captura Biométrica" antiga, não o assistente.
   */
  async function abrirAssinatura() {
    const aberto = () => botaoWizard('Capturar digital') || botaoWizard('Avançar') || botaoWizard('Gerar PDF no SOCGED');
    if (aberto()) return aberto(); // já aberto pelo usuário
    const b = await waitFor(() => visivelPorId('processoCompletoAssinar'),
      'botão "Capturar biometria, criar pdf e assinar"');
    b.click();
    return waitFor(aberto, 'assistente de assinatura');
  }

  /** Elemento visível com o id (a página repete ids: ex. dois #botaoInstalacaoBRy, um oculto). */
  const visivelPorId = (id) => [...document.querySelectorAll(`[id="${id}"]`)].find(visible);

  /** Gerar PDF no SOCGED → Assinar PDF Digitalmente → certificado → Iniciar Assinatura. Para aí. */
  async function gerarEAssinar(timeoutGerar = CONFIG.timeoutMs) {
    (await waitFor(() => botaoWizard('Gerar PDF no SOCGED'), '"Gerar PDF no SOCGED"', timeoutGerar)).click();
    (await waitFor(() => botaoWizard('Assinar PDF Digitalmente'), '"Assinar PDF Digitalmente"')).click();
    const combo = await waitFor(() => visivelPorId('combo_certificados'), 'lista de certificados');
    const { operador, certificado } = CONFIG.assinatura;
    const opt = [...combo.options].find((o) => certificado
      ? o.value.toUpperCase().startsWith(certificado.toUpperCase())
      : norm(o.text).startsWith(norm(operador)));
    if (!opt) throw new Error('certificado de ' + operador + ' não encontrado');
    combo.value = opt.value;
    combo.dispatchEvent(new Event('change', { bubbles: true }));
    (await waitFor(() => visivelPorId('botaoInstalacaoBRy'), '"Iniciar Assinatura"')).click();
    toast('Assinatura iniciada — digite a senha do certificado');
    // A partir daqui (senha do certificado do Windows) tudo é manual.
  }

  // ---------- Impressão ASO (cad017.do em aba própria) ----------
  async function fluxoImpressaoAso() {
    await abrirAssinatura();
    // Biometria já foi coletada na triagem: "Avançar" se existir; senão segue direto.
    const prox = await waitFor(() => botaoWizard('Avançar') || botaoWizard('Gerar PDF no SOCGED'), '"Avançar"');
    if (norm(prox.innerText) === 'AVANÇAR') prox.click();
    await gerarEAssinar();
  }

  // ---------- Assinar prontuários (cad225!imprimirTodosProntuarios, aba própria) ----------
  async function fluxoProntuarios() {
    // O botão de assinar (#processoCompletoAssinar) só aparece depois que a ficha carrega.
    // Clicar de novo em "Ficha Clínica" com ela aberta a recolheria.
    if (!visivelPorId('processoCompletoAssinar')) document.getElementById('fichaClinicaC').click();
    await abrirAssinatura();
    const btn = await waitFor(() => botaoWizard('Capturar digital') || botaoWizard('Avançar'), 'janela de biometria');
    btn.click();
    if (norm(btn.innerText) === 'CAPTURAR DIGITAL') {
      toast('Faça a captura da digital — o SOCFlow continua depois');
      // Captura manual (até 5 min): espera a janela "Captura Biométrica" abrir e fechar.
      const captura = () => visivelPorId('btn-cancelar-biometria');
      await waitFor(captura, 'janela de captura', 15000).catch(() => {});
      await waitFor(() => !captura(), 'captura da digital', 5 * 60000);
      // Após a captura segue para "Gerar PDF no SOCGED"; se o assistente liberar "Avançar", clica.
      const prox = await waitFor(() => botaoWizard('Gerar PDF no SOCGED') || botaoWizard('Avançar'), '"Gerar PDF no SOCGED"');
      if (norm(prox.innerText) === 'AVANÇAR') prox.click();
    }
    await gerarEAssinar();
  }

  // ---------- 264 ASO Rápido ----------
  // A página recarrega a cada ação (alterar/gravar), então o passo seguinte é retomado
  // pelo novo carregamento do frame via sessionStorage.
  const ASO_STEP = 'socflow.aso.step';
  const hoje = () => new Date().toLocaleDateString('pt-BR'); // dd/mm/aaaa

  function preencherAso() {
    const sel = document.getElementById('parecerAso');
    // "APTO" ou "APTO PARA FUNÇÃO" conforme a empresa — nunca "com restrições"/"inapto".
    const opt = [...sel.options].find((o) => ['APTO', 'APTO PARA FUNÇÃO'].includes(norm(o.text)));
    if (!opt) throw new Error('opção APTO não encontrada no parecer');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const data = document.getElementById('dataEmissaoAso');
    if (data.value !== hoje()) {
      log('data de emissão', data.value, '->', hoje());
      data.value = hoje();
      data.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function fluxoAso() {
    if (acao('save')) { // já em modo edição
      preencherAso();
      passo.marcar(ASO_STEP, 'gravado');
      acao('save').click();
    } else if (acao('alt')) {
      passo.marcar(ASO_STEP, 'alterando');
      acao('alt').click();
    } else throw new Error('botão Alterar não encontrado');
  }

  function retomarAso() {
    const step = passo.consumir(ASO_STEP);
    if (step === 'alterando' && acao('save')) run('ASO', fluxoAso);
    else if (step === 'gravado' && acao('imprimir')) {
      // O Chrome bloqueia a aba de impressão sem gesto do usuário, a menos que os
      // pop-ups de sistema.soc.com.br estejam permitidos.
      if (CONFIG.aso.imprimirAutomatico) acao('imprimir').click();
      else toast('ASO gravado — pressione F8 para imprimir');
    }
  }

  /** Valor exibido ao lado de um rótulo no modo visualização. */
  function valorExibido(rotulo) {
    const td = [...document.querySelectorAll('td')].find((t) => norm(t.innerText).startsWith(norm(rotulo)));
    return td && td.nextElementSibling ? norm(td.nextElementSibling.innerText) : '';
  }

  /** Valor ao lado de um rótulo exato (ex.: "Sexo", "Tipo"). */
  function valorDoRotulo(rotulo) {
    const td = [...document.querySelectorAll('td')].find((t) => norm(t.innerText) === norm(rotulo));
    return td && td.nextElementSibling ? norm(td.nextElementSibling.innerText) : '';
  }

  function f8Aso() {
    // Modo visualização com parecer APTO e data de hoje: F8 imprime (F8 conta como gesto do usuário).
    const pronto = !acao('save') && acao('imprimir') &&
      ['APTO', 'APTO PARA FUNÇÃO'].includes(valorExibido('Parecer')) &&
      valorExibido('Data Emissão') === hoje();
    if (pronto) acao('imprimir').click();
    else fluxoAso();
  }

  // ---------- 229 Ficha Clínica (cad009.do) ----------
  // Questionário personalizado: blocos <table class="subgrupoN"> agrupados sob linhas-título
  // de seção ("EXAME FÍSICO", "CONDUTA MÉDICA"...). Preenche só o que está vazio.
  const FICHA_STEP = 'socflow.ficha.preencher';

  /** Título da seção a que o bloco pertence (linha anterior sem subgrupo). */
  function secaoDoBloco(t) {
    let tr = t.closest('tr');
    while (tr && (tr = tr.previousElementSibling)) {
      if (!tr.querySelector('table[class^=subgrupo]') && norm(tr.innerText)) return norm(tr.innerText);
    }
    return '';
  }

  /** Texto da opção (nós após o radio/checkbox até o próximo input). */
  function rotuloOpcao(input) {
    let t = '';
    for (let n = input.nextSibling; n && n.nodeName !== 'INPUT' && t.length < 80; n = n.nextSibling) t += n.textContent || '';
    if (t.trim()) return norm(t);
    if (input.labels && input.labels[0]) return norm(input.labels[0].innerText);
    const td = input.closest('td'); // opção sozinha numa célula
    return td && td.querySelectorAll('input').length === 1 ? norm(td.innerText) : '';
  }

  /** Ficha SOCNET = selo "SOCNET" na barra do topo. */
  const fichaSocnet = () => [...window.top.document.querySelectorAll('span')]
    .some((e) => !e.children.length && norm(e.innerText) === 'SOCNET' && visible(e));

  /**
   * Preenche um bloco (subgrupo) só se nada nele estiver respondido.
   * Radios: resposta configurada pela pergunta, senão "Normal"/"Negativo".
   * Checkboxes: todas as opções "Normal..."/"Nega...". Nunca desmarca nada.
   */
  function preencherBloco(t, cont) {
    const inputs = [...t.querySelectorAll('input[type=radio],input[type=checkbox]')];
    if (!inputs.length) return;
    if (inputs.some((i) => i.checked)) { cont.mantidos++; return; }
    const titulo = norm(t.rows[0] && t.rows[0].innerText);
    const grupos = [...new Set(inputs.filter((i) => i.type === 'radio').map((r) => r.name))];
    for (const nome of grupos) {
      const radios = inputs.filter((r) => r.name === nome);
      // A pergunta fica na linha do radio ("Varizes Sim Não") ou no título do bloco ("Refeições regulares?").
      const linha = norm(radios[0].closest('tr').innerText);
      const chave = Object.keys(CONFIG.ficha.respostas)
        .find((k) => linha.startsWith(norm(k)) || titulo.startsWith(norm(k)));
      const alvo = chave
        ? radios.find((r) => rotuloOpcao(r) === norm(CONFIG.ficha.respostas[chave]))
        : radios.find((r) => /^(NORMAL|NEGATIVO)/.test(rotuloOpcao(r)));
      if (alvo) { alvo.click(); cont.marcados++; }
    }
    for (const c of inputs.filter((i) => i.type === 'checkbox' && /^(NORMAL|NEGA)/.test(rotuloOpcao(i)))) {
      c.click(); cont.marcados++;
    }
  }

  function preencherFicha() {
    const cfg = CONFIG.ficha;
    const blocos = [...document.querySelectorAll('table[class^=subgrupo]')]
      .map((t) => ({ t, secao: secaoDoBloco(t), titulo: norm(t.rows[0] && t.rows[0].innerText) }));
    const cont = { marcados: 0, mantidos: 0 };

    if (fichaSocnet()) {
      // SOCNET (formulário da empresa): só EXAME FÍSICO + 1ª opção da CONDUTA GERAL.
      const empresa = (document.querySelector('input[name=empresaNavegacao]') || {}).value;
      const regra = cfg.socnet[empresa];
      if (!regra) { toast(`Ficha SOCNET da empresa ${empresa}: sem regra no CONFIG, nada preenchido`); return; }
      for (const { t, secao, titulo } of blocos) {
        if (secao.startsWith('EXAME FÍSICO') && !regra.ignorarExames.some((x) => titulo.includes(norm(x)))) preencherBloco(t, cont);
      }
      if (regra.condutaPrimeiraOpcao) {
        const conduta = blocos.find((b) => b.titulo.startsWith('CONDUTA GERAL'));
        const caixas = conduta ? [...conduta.t.querySelectorAll('input[type=checkbox]')] : [];
        if (caixas.length && !caixas.some((c) => c.checked)) { caixas[0].click(); cont.marcados++; }
        else if (caixas.length) cont.mantidos++;
      }
    } else {
      // Padrão (não SOCNET): anamnese padrão + todo o questionário normal/nega.
      // Anamnese: padrão se vazia; homem sem a linha "DUM"; demissional sem as linhas
      // de alergias/lentes/tabagismo (mesmo que alteradas).
      const anamnese = document.querySelector('textarea[name=anamnese]');
      if (anamnese) {
        const masculino = valorDoRotulo('Sexo') === 'MASCULINO';
        const demissional = valorDoRotulo('Tipo') === 'DEMISSIONAL';
        const texto = anamnese.value.trim() ? anamnese.value : cfg.anamnesePadrao;
        // A anamnese da triagem costuma vir num parágrafo só: filtra por frase (". ") dentro de cada linha.
        const manter = (frase) => {
          const n = norm(frase);
          if (masculino && /^DUM\b/.test(n)) return false;
          return !(demissional && cfg.anamneseRemoverDemissional.some((p) => n.includes(norm(p))));
        };
        const novo = texto.split('\n')
          .map((linha) => linha.split(/(?<=\.)\s+/).filter(manter).join(' '))
          .filter((linha, i, arr) => linha.trim() || arr.length === 1)
          .join('\n');
        if (novo !== anamnese.value) {
          anamnese.value = novo;
          anamnese.dispatchEvent(new Event('input', { bubbles: true }));
          anamnese.dispatchEvent(new Event('change', { bubbles: true }));
          cont.marcados++;
        } else cont.mantidos++;
      }
      for (const { t } of blocos) preencherBloco(t, cont);
    }

    if (!cont.marcados && !cont.mantidos) return; // ficha sem questionário personalizado
    toast(`Ficha: ${cont.marcados} campo(s) preenchido(s), ${cont.mantidos} bloco(s) já preenchido(s) mantido(s)`);
  }

  function editarFicha() {
    const a = acao('alt');
    if (!a) return false;
    passo.marcar(FICHA_STEP, true);
    a.click();
    return true;
  }

  function retomarFicha() {
    if (passo.consumir(FICHA_STEP) && acao('save')) run('Ficha', preencherFicha);
  }

  // ---------- automações F8 ----------
  const f8 = {
    aso: () => run('ASO', f8Aso),
    impressaoAso: () => run('Impressão ASO', fluxoImpressaoAso),
    prontuarios: () => run('Prontuários', fluxoProntuarios),
  };

  // ---------- atalhos ----------
  // Cada frame registra sua instância em window.__socflow; o listener de qualquer
  // frame roteia o atalho para o frame cuja página sabe tratá-lo.
  const clicar = (x, nome) => () => {
    const a = acao(x);
    if (!a) return false;
    a.click();
    log(nome);
    return true;
  };
  window.__socflow = {
    page,
    f8: f8[page],
    f7: page === 'ficha' ? editarFicha : null, // F7: editar ficha clínica (+ preencher normais)
    salvar: clicar('save', 'salvar'),                             // Ctrl+Enter: gravar (qualquer tela)
  };

  function allFrames(w = window.top, acc = []) {
    acc.push(w);
    for (let i = 0; i < w.frames.length; i++) {
      try { void w.frames[i].document; allFrames(w.frames[i], acc); } catch (_) { /* cross-origin */ }
    }
    return acc;
  }

  /** Executa a ação `tipo` no primeiro frame que a trate (função que não retorne false). */
  function despachar(tipo, rotulo) {
    for (const w of allFrames()) {
      const fn = w.__socflow && w.__socflow[tipo];
      if (fn && fn() !== false) return;
    }
    toast(rotulo + ': nada a fazer nesta página', true);
  }

  // No window (fase de captura): algumas telas (ex.: modal de biometria) interrompem a
  // propagação do teclado antes de chegar ao document.
  window.addEventListener('keydown', (e) => {
    const tipo =
      e.key === 'F8' ? 'f8' :
      e.key === 'F7' ? 'f7' :
      e.key === 'Enter' && e.ctrlKey ? 'salvar' : null;
    if (!tipo) return;
    e.preventDefault(); e.stopPropagation();
    despachar(tipo, { f8: 'F8', f7: 'F7', salvar: 'Ctrl+Enter' }[tipo]);
  }, true);

  // ---------- botão de ajuda (só na janela principal de cada aba) ----------
  function criarAjuda() {
    const AJUDA = [
      ['F8', 'Automação da tela atual:'],
      ['', '• ASO Rápido (264): Alterar → parecer APTO → data de hoje → Gravar. F8 de novo: imprimir.'],
      ['', '• Impressão ASO: Avançar → Gerar PDF no SOCGED → Assinar → certificado → Iniciar Assinatura.'],
      ['', '• Assinar prontuários: Ficha Clínica → Capturar digital (você captura) → PDF → assinatura.'],
      ['F7', 'Ficha Clínica: Alterar e preencher os campos normais vazios (não altera o que já está respondido).'],
      ['Ctrl+Enter', 'Gravar (qualquer tela com o botão Gravar).'],
      ['Enter', 'Pesquisa Avançada (088): buscar o nome/CPF digitado.'],
      ['', 'A senha do certificado digital é sempre digitada por você.'],
    ];
    const css = document.createElement('style');
    css.textContent = `
      #socflow-ajuda-btn{position:fixed;left:10px;bottom:10px;z-index:2147483646;width:24px;height:24px;border-radius:50%;
        border:1px solid #9e9e9e;background:#fff;color:#555;font:bold 13px/22px sans-serif;text-align:center;cursor:pointer;
        opacity:.35;transition:opacity .15s;padding:0}
      #socflow-ajuda-btn:hover,#socflow-ajuda-btn:focus-visible,#socflow-ajuda-btn[aria-expanded=true]{opacity:1}
      #socflow-ajuda{position:fixed;left:10px;bottom:42px;z-index:2147483646;max-width:440px;padding:12px 14px;border-radius:8px;
        background:#fff;color:#222;font:12px/1.45 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);border:1px solid #ddd}
      #socflow-ajuda[hidden]{display:none}
      #socflow-ajuda *{font-family:sans-serif;color:#222;background:none;text-transform:none;letter-spacing:normal}
      #socflow-ajuda h2{margin:0 0 8px;font-size:13px;font-weight:bold}
      #socflow-ajuda table{border-collapse:collapse;width:auto}
      #socflow-ajuda td{padding:2px 6px 2px 0;vertical-align:top;font-size:12px;line-height:1.45;border:0;text-align:left}
      #socflow-ajuda kbd{font:11px monospace;background:#f1f1f1;border:1px solid #ccc;border-radius:3px;padding:0 4px;white-space:nowrap}
      #socflow-ajuda footer{margin-top:8px;padding-top:6px;border-top:1px solid #eee;font-size:11px}
      #socflow-ajuda footer,#socflow-ajuda footer *{color:#666}
      #socflow-ajuda a{color:#1565c0;text-decoration:underline}`;
    document.head.appendChild(css);

    const painel = document.createElement('div');
    painel.id = 'socflow-ajuda';
    painel.hidden = true;
    painel.setAttribute('role', 'dialog');
    painel.setAttribute('aria-label', 'Ajuda do SOCFlow');
    const h = document.createElement('h2');
    h.textContent = `SOCFlow v${VERSAO} — atalhos`;
    const tabela = document.createElement('table');
    for (const [tecla, texto] of AJUDA) {
      const tr = tabela.insertRow();
      const c1 = tr.insertCell();
      if (tecla) { const k = document.createElement('kbd'); k.textContent = tecla; c1.appendChild(k); }
      tr.insertCell().textContent = texto;
    }
    const rodape = document.createElement('footer');
    const link = (href, txt) => { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = txt; return a; };
    rodape.append(`Versão instalada: ${VERSAO} · `, link(REPO, 'repositório'), ' · ', link(INSTALAR, 'instalar/atualizar'));
    painel.append(h, tabela, rodape);

    const btn = document.createElement('button');
    btn.id = 'socflow-ajuda-btn';
    btn.type = 'button';
    btn.textContent = '?';
    btn.title = `SOCFlow v${VERSAO} — ajuda dos atalhos`;
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', painel.id);
    const alternar = (abrir) => {
      painel.hidden = !abrir;
      btn.setAttribute('aria-expanded', String(abrir));
    };
    btn.addEventListener('click', () => alternar(painel.hidden));
    document.addEventListener('click', (e) => { if (!painel.hidden && !painel.contains(e.target) && e.target !== btn) alternar(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !painel.hidden) { alternar(false); btn.focus(); } });
    document.body.append(painel, btn);
  }

  if (isTop && document.body) criarAjuda();
  if (page === 'pesquisa') initPesquisa();
  if (page === 'aso') retomarAso();
  if (page === 'ficha') retomarFicha();
  if (page) log(`v${VERSAO} página:`, page);
})();
