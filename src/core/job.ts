import { ChildProcess, spawn, spawnSync } from "child_process";

/**
 * Windows: põe o processo do `claude` num Job Object com KILL_ON_JOB_CLOSE.
 * Tudo o que ele iniciar herda o job -- inclusive o que fica órfão quando o pai
 * morre, como o PostgreSQL embutido dos testes de um backend Java. O `taskkill
 * /T` não alcança órfãos (a árvore se perde quando o pai morre), e um órfão
 * vivo segura a pasta da worktree: ela não sai do disco e a próxima tentativa
 * da tarefa bate em "already exists". Fechar o job mata todos de uma vez.
 *
 * Sem dependência nativa: o job é criado por um PowerShell que fica vivo
 * segurando o handle até o stdin fechar. Se o PowerShell não conseguir (política
 * da máquina, antivírus), a execução segue como antes -- só sem essa limpeza.
 */
export interface Contencao {
  /** Resolve quando o processo entrou no job (true) ou não conseguiu (false). */
  pronto: Promise<boolean>;
  /** Fecha o job: o que ainda estiver vivo dentro dele morre. */
  encerrar(): Promise<void>;
}

function script(pid: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CqJob {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr j, int c, IntPtr i, uint l);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool h, int pid);
}
'@
$job = [CqJob]::CreateJobObject([IntPtr]::Zero, $null)
# JOBOBJECT_EXTENDED_LIMIT_INFORMATION (144 bytes no x64); LimitFlags fica no offset 16
$tam = 144
$info = [Runtime.InteropServices.Marshal]::AllocHGlobal($tam)
for ($i = 0; $i -lt $tam; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($info, $i, 0) }
[Runtime.InteropServices.Marshal]::WriteInt32($info, 16, 0x2000)
if (-not [CqJob]::SetInformationJobObject($job, 9, $info, $tam)) { [Console]::Out.WriteLine('erro: SetInformationJobObject'); exit 2 }
$proc = [CqJob]::OpenProcess(0x0101, $false, ${pid})
if ($proc -eq [IntPtr]::Zero -or -not [CqJob]::AssignProcessToJobObject($job, $proc)) { [Console]::Out.WriteLine('erro: AssignProcessToJobObject'); exit 3 }

# Só o que nascer DEPOIS da atribuição herda o job. O que o processo já tinha
# criado (o node por trás de um claude.cmd, por exemplo) é preso aqui, descendo
# a árvore. Um filho nunca é mais velho que o pai: isso descarta processo antigo
# cujo pai morto tinha, por acaso, o mesmo PID.
function Prender {
  $todos = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate
  $porId = @{}; $filhos = @{}
  foreach ($p in $todos) {
    $porId[[int]$p.ProcessId] = $p
    $pai = [int]$p.ParentProcessId
    if (-not $filhos.ContainsKey($pai)) { $filhos[$pai] = New-Object System.Collections.ArrayList }
    [void]$filhos[$pai].Add($p)
  }
  if (-not $porId.ContainsKey(${pid})) { return }
  $fila = New-Object System.Collections.Queue
  $fila.Enqueue($porId[${pid}])
  while ($fila.Count -gt 0) {
    $atual = $fila.Dequeue()
    $id = [int]$atual.ProcessId
    if (-not $filhos.ContainsKey($id)) { continue }
    foreach ($f in $filhos[$id]) {
      if ([int]$f.ProcessId -eq $id -or $f.CreationDate -lt $atual.CreationDate) { continue }
      $h = [CqJob]::OpenProcess(0x0101, $false, [int]$f.ProcessId)
      if ($h -ne [IntPtr]::Zero) { [void][CqJob]::AssignProcessToJobObject($job, $h) }
      $fila.Enqueue($f)
    }
  }
}
Prender
[Console]::Out.WriteLine('ok')
# segura o job até o stdin fechar, prendendo de novo de tempos em tempos (reforço
# para filho criado entre a varredura e a atribuição do pai)
$linha = [Console]::In.ReadLineAsync()
while (-not $linha.Wait(5000)) { try { Prender } catch { } }
`;
}

export function conterProcesso(pid: number, log: (msg: string) => void): Contencao {
  const codificado = Buffer.from(script(pid), "utf16le").toString("base64");
  let ajudante: ChildProcess;
  try {
    ajudante = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", codificado],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch (e) {
    log(`não consegui conter os processos da tarefa: ${e instanceof Error ? e.message : String(e)}`);
    return { pronto: Promise.resolve(false), encerrar: async () => {} };
  }

  let contido = false;
  let encerrando = false;
  let saida = "";
  let avisar: (v: boolean) => void = () => {};
  const pronto = new Promise<boolean>((res) => (avisar = res));
  ajudante.stdout!.setEncoding("utf8");
  ajudante.stdout!.on("data", (d: string) => {
    saida += d;
    if (!contido && /^ok\s*$/m.test(saida)) {
      contido = true;
      avisar(true);
    }
  });
  ajudante.stderr!.on("data", () => {});
  ajudante.on("error", () => {});
  const fim = new Promise<void>((res) => ajudante.on("close", () => res()));
  void fim.then(() => avisar(false));
  void fim.then(() => {
    if (!contido && !encerrando) {
      log(`não consegui conter os processos da tarefa (${saida.trim() || "PowerShell saiu sem resposta"}); órfãos não serão encerrados`);
    }
  });

  return {
    pronto,
    async encerrar() {
      encerrando = true;
      if (!contido) {
        // Ainda não assumiu o job (tarefa muito curta): não há o que fechar.
        if (ajudante.pid) spawnSync("taskkill", ["/PID", String(ajudante.pid), "/F"], { windowsHide: true });
        return;
      }
      ajudante.stdin!.end();
      const prazo = new Promise<"prazo">((res) => setTimeout(() => res("prazo"), 10_000));
      if ((await Promise.race([fim, prazo])) === "prazo" && ajudante.pid) {
        // Matar o PowerShell também fecha o handle -- e o job mata o resto.
        spawnSync("taskkill", ["/PID", String(ajudante.pid), "/F"], { windowsHide: true });
      }
    },
  };
}
