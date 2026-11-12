# 💅 Nail Designer — Agendamento online

Sistema completo para nail designers e estúdios de unhas: site da cliente com agendamento online e painel para o estúdio administrar a agenda. Visual claro, em branco e azul.

**Sem dependências**: só precisa do Node.js 22.13+ (usa o SQLite embutido no Node).

## Rodar

```bash
npm start
```

- Site da cliente: http://localhost:3000
- Painel do estúdio: http://localhost:3000/admin — senha inicial **`admin123`** (troque na aba "Estúdio")

Variáveis opcionais: `PORT`, `ADMIN_PASSWORD` (senha inicial na primeira execução), `DB_FILE`.
Os dados ficam em `data/estudio.db`.

## Funcionalidades

**Cliente (`/`)**
- Serviços com preço e duração (manicure, pedicure, mão + pé, nail art, spa das mãos, esmaltação em gel, alongamento em gel — tudo editável)
- Agendamento em 5 passos: serviço → profissional (ou "qualquer profissional") → dia → horário livre → nome/telefone
- Horários livres consideram expediente, intervalo de almoço, folgas e outras clientes
- Horário já agendado aparece como **ocupado** (indisponível), com a opção de entrar na **fila de espera**
- Código de confirmação + atalho para avisar pelo WhatsApp
- Consulta e cancelamento online pelo código + telefone (também mostra o lugar na fila e permite sair dela)
- Para cancelar, a cliente **precisa informar o motivo**; depois, o WhatsApp abre com a mensagem pronta para a profissional (ou para o estúdio, se ela não tiver número cadastrado)
- Endereço, mapa, link "como chegar", horário de funcionamento e status "aberto agora"

**Estúdio (`/admin`)**
- **Agenda** do dia por profissional, com faturamento previsto/realizado e status (confirmado, atendido, cancelado, não compareceu)
- **Agendamento manual** (cliente que ligou ou mandou mensagem)
- **Cancelar pelo painel**: com motivo (opcional), e a mensagem para a cliente sai pronta no WhatsApp
- **Aviso de cancelamento**: quando uma cliente cancela pelo site, o painel mostra quem, quando e o motivo
- **WhatsApp de cada profissional**: recebe os avisos de cancelamento das clientes dela
- **Fila de espera**: lista de quem aguarda cada horário do dia; quando alguém ganha a vaga, aparece um aviso com botão para avisar a cliente pelo WhatsApp
- **Serviços e preços**: criar, editar, desativar
- **Profissionais e expediente**: horário de cada dia da semana e intervalo de almoço por profissional
- **Folgas e bloqueios**: dia inteiro ou faixa de horário, para uma profissional ou o estúdio todo (avisa se já houver clientes marcadas)
- **Configurações**: nome, endereço (mapa), telefone, WhatsApp, Instagram, intervalo entre horários, antecedência mínima, dias à frente, prazo de cancelamento

## Como funciona a fila de espera

1. A cliente toca em um horário ocupado e entra na fila com nome e telefone. Recebe um código.
2. Quando o horário vaga (cliente cancelou, estúdio cancelou, bloqueio removido ou expediente ampliado), a **primeira da fila é agendada automaticamente**, com o mesmo código.
3. O painel mostra "Vaga liberada para Fulana" com um botão que abre o WhatsApp com a mensagem pronta. O envio **não é automático**: o estúdio clica para avisar.
4. Vaga que surge em cima da hora (dentro da antecedência mínima de agendamento) não é preenchida automaticamente: a cliente continua na lista do painel e o estúdio pode chamá-la se quiser. Passado o horário, a fila se encerra.

Quem escolhe "qualquer profissional" só entra na fila se todas estiverem ocupadas naquele horário, e fica com a primeira que vagar.

## Estrutura

```
server.js        API REST + servidor de arquivos
db.js            Banco SQLite, esquema e dados iniciais
public/
  index.html     Site da cliente
  app.js
  admin.html     Painel do estúdio
  admin.js
  common.js      Funções compartilhadas
  style.css      Tema branco e azul
```

## Vídeo de apresentação

`apresentacao/nails-apresentacao.mp4` é um vídeo de 1 min 50 s, com narração, para mostrar o sistema a nail designers. Ele é gerado por código a partir das telas reais do sistema; veja `apresentacao/LEIA-ME.md` para editar e gerar de novo.

## Próximos passos sugeridos para produção
- HTTPS e hospedagem (Railway, Render, VPS)
- Lembretes automáticos por WhatsApp/SMS (ex.: API do WhatsApp Business)
- Login individual por profissional
- Galeria de trabalhos (fotos de nail art) no site
- Pagamento antecipado / sinal via Pix
