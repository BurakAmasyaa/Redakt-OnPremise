using System;
using System.Collections.Specialized;
using System.IO;
using System.Reflection;
using System.Web;

// Windows kimligini (LOGON_USER) kimlik dogrulama SONRASI X-Remote-User
// basligina yazar; ters proxy bu basligi Node servisine iletir ve servis
// AUTH_MODE=proxy ile ona guvenir.
//
// Neden modul: URL Rewrite'in {LOGON_USER} server degiskeni kural
// calistiginda (BeginRequest) HENUZ BOS olur. serverVariables ile yazilan
// baslik bu yuzden bos gider ve servis her istegi "kimlik basligi yok"
// diye reddeder. Bu modul PostAuthenticateRequest'te calisir; kimlik orada
// dolmustur.
//
// Istemcinin gonderdigi X-Remote-User HER KOSULDA ezilir (headers.Set):
// aksi halde kullanici kendi istegine baslik ekleyip baskasi gibi gorunur.
//
// Kurulum: bu dosya site kokundeki App_Code klasorune konur; ASP.NET onu
// calisma aninda derler (app pool: CLR v4.0, Integrated). Derleyici ya da
// Visual Studio gerekmez.
public class HeaderInjectorModule : IHttpModule
{
    public void Init(HttpApplication context)
    {
        context.PostAuthenticateRequest += OnPostAuthenticateRequest;
    }

    private void OnPostAuthenticateRequest(object sender, EventArgs e)
    {
        var app = (HttpApplication)sender;
        var request = app.Context.Request;

        string user = request.LogonUserIdentity != null ? request.LogonUserIdentity.Name : null;

        // Kimlik yoksa istemcinin gonderdigi olasi sahte basligi da temizle.
        if (string.IsNullOrEmpty(user))
        {
            SetHeader(request, "X-Remote-User", "");
            return;
        }

        SetHeader(request, "X-Remote-User", user);
    }

    // ASP.NET gelen istek basliklarini salt okunur tutar; yazabilmek icin
    // koleksiyonun kilidi yansima ile acilir. Property yoksa (surum farki)
    // alan adlarina duselir.
    private static bool SetHeader(HttpRequest request, string name, string value)
    {
        NameValueCollection headers = request.Headers;

        Type t = headers.GetType();
        while (t != null)
        {
            PropertyInfo prop = t.GetProperty("IsReadOnly", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
            if (prop != null && prop.CanWrite)
            {
                try
                {
                    prop.SetValue(headers, false, null);
                    // NOT: Kasitli olarak tekrar true yapmiyoruz. ASP.NET'in ic
                    // senkronizasyonu (IIS7WorkerRequest) koleksiyonu sonra tekrar
                    // yazmaya calisiyor; kilitli birakirsak 'read-only' istisnasi olur.
                    headers.Set(name, value);
                    return true;
                }
                catch (Exception ex) { Log("IsReadOnly property hata (" + t.FullName + "): " + ex.Message); }
            }
            t = t.BaseType;
        }

        string[] candidateFieldNames = { "_isReadOnly", "isReadOnly", "readOnly", "_readOnly" };
        t = headers.GetType();
        while (t != null)
        {
            foreach (string fname in candidateFieldNames)
            {
                FieldInfo f = t.GetField(fname, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
                if (f != null && f.FieldType == typeof(bool))
                {
                    try
                    {
                        f.SetValue(headers, false);
                        headers.Set(name, value);
                        return true;
                    }
                    catch (Exception ex) { Log("Field hata (" + t.FullName + "." + fname + "): " + ex.Message); }
                }
            }
            t = t.BaseType;
        }

        Log("BASARISIZ - " + name + " icin unlock yontemi bulunamadi.");
        return false;
    }

    // Yalnizca basarisizlik durumunda yazar. Yol site koku altindaki logs
    // klasorudur; sabit bir kurulum yoluna baglanmaz. App pool hesabinin o
    // klasore yazma izni yoksa kayit sessizce atlanir, modul calismaya devam eder.
    private static readonly object LockObj = new object();
    private static void Log(string message)
    {
        try
        {
            string root = HttpRuntime.AppDomainAppPath;
            if (string.IsNullOrEmpty(root)) return;
            string directory = Path.Combine(root, "logs");
            string file = Path.Combine(directory, "header-injector.log");
            lock (LockObj)
            {
                Directory.CreateDirectory(directory);
                File.AppendAllText(file, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + message + Environment.NewLine);
            }
        }
        catch { }
    }

    public void Dispose() { }
}
