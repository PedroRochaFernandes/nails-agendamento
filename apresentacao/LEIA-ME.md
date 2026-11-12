# Vídeo de apresentação

`nails-apresentacao.mp4` — apresentação do sistema para nail designers e donas de estúdio (1920×1080, 30 fps, H.264 + AAC, com narração).

Tudo é gerado por código, usando só Node.js, o Chrome/Edge e as vozes do Windows já instalados (sem ffmpeg, sem internet para a voz).

## Ver e editar

Abra `video.html` no navegador: ele toca a apresentação em tempo real (espaço pausa, ← → navegam, um clique liga a narração).

- **Textos na tela**: estão no próprio `video.html`, uma `<section class="scene">` por cena.
- **Duração de cada cena**: atributo `data-dur` (segundos). `data-at` é o instante em que cada texto entra e `data-fx` o efeito de entrada (`words`, `flip`, `pop`, `track`...).
- **Sequência das telas** (trocas, toques, destaques, zoom, reflexo, confete): bloco "roteiro das telas" no fim do arquivo.

## Narração

As falas ficam em `narrar.mjs`: para cada cena, o instante em que a fala começa e o texto. Depois de mudar:

```bash
node apresentacao/narrar.mjs
```

O comando mostra quando cada fala começa e termina e avisa se duas se sobrepõem. Opções:

```bash
node apresentacao/narrar.mjs --voz Daniel --ritmo 1.2
```

- `--voz`: `Maria` (padrão) ou `Daniel`, as vozes em português do Windows.
- `--ritmo`: velocidade da fala (padrão 1.1).

**Música de fundo (opcional):** coloque um arquivo seu em `narracao/musica.mp3` (ou `.m4a`, `.wav`, `.ogg`). Ele entra baixinho por baixo da narração, com início e fim suaves.

## Gerar o MP4

```bash
node apresentacao/renderizar.mjs
```

Leva de 15 a 25 minutos. Outras opções:

```bash
node apresentacao/renderizar.mjs --ate 10
```

renderiza só os primeiros 10 segundos, para testar rápido.

```bash
node apresentacao/renderizar.mjs --previa 3.5,24,68
```

salva só esses instantes (em segundos) como imagem em `_previa/`.

```bash
node apresentacao/renderizar.mjs --conferir
```

abre o MP4 pronto, salva quadros dele em `_previa/` e mostra, segundo a segundo, onde há som.

`--sem-audio` gera o vídeo mudo.

## Recapturar as telas do sistema

As imagens em `telas/` são capturas reais do site e do painel, com dados fictícios. Para refazê-las (por exemplo, depois de mudar o visual do sistema), suba um servidor de demonstração **com banco separado** e rode a captura:

```bash
PORT=3100 DB_FILE=/tmp/demo.db npm start
```

```bash
DEMO_URL=http://localhost:3100 node apresentacao/capturar-telas.mjs
```

O script cria os agendamentos de exemplo, então nunca aponte para o banco real do estúdio.
