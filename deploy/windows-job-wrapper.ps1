param([Parameter(Mandatory=$true)][string]$SpecFile)
# Fixed bootstrap, no profiles or dynamic commands. JSON carries argv as data.
# The parent's stdin is a lifetime control pipe, never inherited by the worker.
$ErrorActionPreference = 'Stop'
try {
    # Contain the bootstrap itself BEFORE Add-Type: Windows PowerShell can spawn
    # csc.exe while compiling. Reflection.Emit declares P/Invokes in-process (no
    # compiler subprocess), so an abort during compilation cannot orphan csc or
    # let it write into a directory after the wrapper has been killed.
    if ([IntPtr]::Size -ne 8) { throw 'Unsupported architecture' }
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('LearnLensOuterJob')), [Reflection.Emit.AssemblyBuilderAccess]::Run)
    $module = $assembly.DefineDynamicModule('Native')
    $type = $module.DefineType('OuterJobNative', [Reflection.TypeAttributes]::Public)
    $attributes = [Reflection.MethodAttributes]::Public -bor [Reflection.MethodAttributes]::Static -bor [Reflection.MethodAttributes]::PinvokeImpl
    $methods = @(
        @('CreateJobObject', [IntPtr], [Type[]]@([IntPtr], [string])),
        @('SetInformationJobObject', [bool], [Type[]]@([IntPtr], [int], [IntPtr], [uint32])),
        @('AssignProcessToJobObject', [bool], [Type[]]@([IntPtr], [IntPtr])),
        @('GetCurrentProcess', [IntPtr], [Type[]]@()),
        @('CloseHandle', [bool], [Type[]]@([IntPtr]))
    )
    foreach ($method in $methods) {
        $definition = $type.DefinePInvokeMethod($method[0], 'kernel32.dll', $attributes, [Reflection.CallingConventions]::Standard, $method[1], $method[2], [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
        $definition.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    }
    $native = $type.CreateType()
    $outerJob = $native::CreateJobObject([IntPtr]::Zero, $null)
    if ($outerJob -eq [IntPtr]::Zero) { throw 'Job creation failed' }
    $limits = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
    try {
        [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] 144), 0, $limits, 144)
        [Runtime.InteropServices.Marshal]::WriteInt32($limits, 16, 0x2000) # KILL_ON_JOB_CLOSE, no breakaway
        if (-not $native::SetInformationJobObject($outerJob, 9, $limits, 144) -or
            -not $native::AssignProcessToJobObject($outerJob, $native::GetCurrentProcess())) {
            $null = $native::CloseHandle($outerJob)
            throw 'Job containment failed'
        }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($limits) }
    # IntPtr deliberately has no managed finalizer. The OS closes this unnamed,
    # non-inheritable job handle when this wrapper exits (including forced exit).
    $spec = [System.IO.File]::ReadAllText($SpecFile) | ConvertFrom-Json
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class LearnLensJob {
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long ProcessTime,JobTime; public uint Flags;
        public UIntPtr MinWS,MaxWS; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority,Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXT_LIMIT {
        public BASIC_LIMIT Basic; public IO_COUNTERS IO;
        public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
        public long UserTime,KernelTime,PeriodUserTime,PeriodKernelTime;
        public uint Faults,TotalProcesses,ActiveProcesses,TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string reserved,desktop,title;
        public int x,y,xSize,ySize,xChars,yChars,fill; public uint flags;
        public short show,reservedBytes; public IntPtr reservedPtr,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO si; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESSINFO { public IntPtr process,thread; public uint pid,tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref EXT_LIMIT info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out ACCOUNTING info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESSINFO pi);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sp, IntPtr sh, IntPtr tp, out IntPtr th, uint access, bool inherit, uint opts);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    static volatile bool cancelled;
    static string Quote(string arg) {
        StringBuilder b = new StringBuilder("\""); int slashes = 0;
        foreach(char c in arg) {
            if(c == '\\') { slashes++; continue; }
            if(c == '"') { b.Append('\\', slashes*2+1); b.Append(c); }
            else { b.Append('\\', slashes); b.Append(c); }
            slashes=0;
        }
        b.Append('\\', slashes*2); return b.Append('"').ToString();
    }
    static IntPtr Inherit(IntPtr handle) {
        IntPtr copy; IntPtr self = GetCurrentProcess();
        if(!DuplicateHandle(self,handle,self,out copy,0,true,2)) throw new Win32Exception();
        return copy;
    }
    public static int Run(string exe, string[] args, string cwd, string environment, string inputPath) {
        IntPtr job=IntPtr.Zero, attrs=IntPtr.Zero, handles=IntPtr.Zero, env=IntPtr.Zero;
        IntPtr stdin=IntPtr.Zero, stdout=IntPtr.Zero, stderr=IntPtr.Zero;
        PROCESSINFO pi = new PROCESSINFO(); bool assigned=false, initialized=false;
        // EOF also handles parent crash/exit. Background so it cannot keep a
        // completed wrapper alive when the parent still holds its pipe open.
        Thread control = new Thread(() => {
            try { var stream=Console.OpenStandardInput(); while(stream.ReadByte()!=-1) {} } catch {}
            cancelled=true;
        });
        control.IsBackground=true; control.Start();
        try {
            job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Win32Exception();
            EXT_LIMIT limit=new EXT_LIMIT();
            // KILL_ON_JOB_CLOSE | JOB_MEMORY | ACTIVE_PROCESS, NO BREAKAWAY flags.
            limit.Basic.Flags=0x2000|0x200|0x8; limit.Basic.ActiveLimit=12;
            limit.JobMemory=new UIntPtr(1024UL*1024*1024);
            if(!SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(typeof(EXT_LIMIT)))) throw new Win32Exception();
            using(var input=new FileStream(inputPath,FileMode.Open,FileAccess.Read,FileShare.Read)) {
                stdin=Inherit(input.SafeFileHandle.DangerousGetHandle());
            }
            stdout=Inherit(GetStdHandle(-11)); stderr=Inherit(GetStdHandle(-12));
            IntPtr length=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref length);
            attrs=Marshal.AllocHGlobal(length);
            if(!InitializeProcThreadAttributeList(attrs,1,0,ref length)) throw new Win32Exception();
            initialized=true; handles=Marshal.AllocHGlobal(3*IntPtr.Size);
            Marshal.WriteIntPtr(handles,0,stdin); Marshal.WriteIntPtr(handles,IntPtr.Size,stdout); Marshal.WriteIntPtr(handles,2*IntPtr.Size,stderr);
            if(!UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) throw new Win32Exception();
            STARTUPINFOEX si=new STARTUPINFOEX(); si.si.cb=Marshal.SizeOf(typeof(STARTUPINFOEX));
            si.si.flags=0x100; si.si.input=stdin; si.si.output=stdout; si.si.error=stderr; si.attributes=attrs;
            StringBuilder command=new StringBuilder(Quote(exe)); foreach(string arg in args) command.Append(' ').Append(Quote(arg));
            env=Marshal.StringToHGlobalUni(environment);
            if(cancelled) return 125;
            // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW.
            if(!CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x4|0x400|0x80000|0x8000000,env,cwd,ref si,out pi)) throw new Win32Exception();
            if(!AssignProcessToJobObject(job,pi.process)) throw new Win32Exception();
            assigned=true;
            if(cancelled) return 125;
            if(ResumeThread(pi.thread)==0xffffffff) throw new Win32Exception();
            while(WaitForSingleObject(pi.process,50)==258) { if(cancelled) return 125; }
            uint exit; if(!GetExitCodeProcess(pi.process,out exit)) return 126;
            return (int)exit;
        } finally {
            if(pi.process!=IntPtr.Zero) {
                if(assigned) {
                    TerminateJobObject(job,125);
                    ACCOUNTING accounting;
                    // Do not report completion while any descendant is alive.
                    while(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero) && accounting.ActiveProcesses!=0) Thread.Sleep(10);
                } else TerminateProcess(pi.process,126); // never resumed if assignment failed
                WaitForSingleObject(pi.process,0xffffffff);
            }
            if(job!=IntPtr.Zero) CloseHandle(job);
            if(pi.thread!=IntPtr.Zero) CloseHandle(pi.thread); if(pi.process!=IntPtr.Zero) CloseHandle(pi.process);
            foreach(IntPtr h in new[]{stdin,stdout,stderr}) if(h!=IntPtr.Zero) CloseHandle(h);
            if(initialized) DeleteProcThreadAttributeList(attrs);
            if(attrs!=IntPtr.Zero) Marshal.FreeHGlobal(attrs); if(handles!=IntPtr.Zero) Marshal.FreeHGlobal(handles); if(env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
        }
    }
}
'@
    $pairs = @($spec.env.psobject.Properties | Sort-Object Name | ForEach-Object { $_.Name + '=' + [string]$_.Value })
    $environment = [string]::Join([char]0, $pairs) + [char]0 + [char]0
    $code = [LearnLensJob]::Run([string]$spec.executable, [string[]]$spec.args, [string]$spec.cwd, $environment, [string]$spec.inputFile)
    exit $code
} catch {
    [Console]::Error.WriteLine('Owned helper could not start or complete safely.')
    exit 126
}
