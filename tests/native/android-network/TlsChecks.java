package com.baristajobmatch.tlschecks;
import android.app.Instrumentation;
import android.os.Bundle;
import android.os.Build;
import android.content.Context;
import android.net.http.X509TrustManagerExtensions;
import java.net.URL;
import java.security.KeyStore;
import java.security.cert.*;
import javax.net.ssl.*;
import java.util.*;
public class TlsChecks extends Instrumentation {
  private final ArrayList<String> checks=new ArrayList<>();
  private int failures=0;
  @Override public void onCreate(Bundle b) {super.onCreate(b);start();}
  private void check(String label,boolean ok) {checks.add((ok?"PASS ":"FAIL ")+label);if(!ok)failures++;}
  private String causes(Throwable t) {String s="";while(t!=null){s+=t.getClass().getSimpleName()+";";t=t.getCause();}return s;}
  private void rejected(String url,String expected) {
    HttpsURLConnection c=null;
    try {c=(HttpsURLConnection)new URL(url).openConnection();c.setConnectTimeout(15000);c.setReadTimeout(15000);c.setInstanceFollowRedirects(false);c.getResponseCode();check(expected,false);}
    catch(Exception e){String s=causes(e);check(expected+" "+s,s.contains("SSLHandshakeException")||s.contains("SSLPeerUnverifiedException"));}
    finally{if(c!=null)c.disconnect();}
  }
  @Override public void onStart(){
    try {
      Context ctx=getTargetContext();check("target app context",ctx.getPackageName().equals("com.baristajobmatch.app"));
      // Android 16 blocks cached/background processes from network access. Exercise the
      // foreground app, matching the user journey, without changing OS network policy.
      android.content.Intent launch=ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
      launch.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
      startActivitySync(launch);waitForIdleSync();
      check("packaged network config",ctx.getResources().getIdentifier("baristamatch_network_security", "xml", ctx.getPackageName())!=0);
      android.content.res.XmlResourceParser xml=ctx.getResources().getXml(ctx.getResources().getIdentifier("baristamatch_network_security", "xml", ctx.getPackageName()));
      int domains=0,additionalRoots=0;
      while(xml.next()!=org.xmlpull.v1.XmlPullParser.END_DOCUMENT)if(xml.getEventType()==org.xmlpull.v1.XmlPullParser.START_TAG){
        if("domain".equals(xml.getName()))domains++;
        if("certificates".equals(xml.getName())&&xml.getAttributeResourceValue(null,"src",0)!=0)additionalRoots++;
      }
      xml.close();
      check("OS selects intended trust configuration",Build.VERSION.SDK_INT<26?domains==3&&additionalRoots==1:domains==0&&additionalRoots==0);
      String host="testing.baristajobmatch.com";
      HttpsURLConnection c=(HttpsURLConnection)new URL("https://"+host+"/api/public-config").openConnection();c.setConnectTimeout(15000);c.setReadTimeout(15000);c.setInstanceFollowRedirects(false);
      check("public HTTPS status 200",c.getResponseCode()==200);c.disconnect();
      SSLSocket socket=(SSLSocket)SSLSocketFactory.getDefault().createSocket(host,443);
      SSLParameters params=socket.getSSLParameters();params.setEndpointIdentificationAlgorithm("HTTPS");socket.setSSLParameters(params);socket.setSoTimeout(15000);socket.startHandshake();
      SSLSession session=socket.getSession();
      check("correct hostname accepted",HttpsURLConnection.getDefaultHostnameVerifier().verify(host,session));
      check("wrong hostname rejected",!HttpsURLConnection.getDefaultHostnameVerifier().verify("wrong.baristajobmatch.com",session));
      java.security.cert.Certificate[] raw=session.getPeerCertificates();X509Certificate[] chain=Arrays.copyOf(raw,raw.length,X509Certificate[].class);
      TrustManagerFactory factory=TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());factory.init((KeyStore)null);
      X509TrustManager tm=null;for(TrustManager candidate:factory.getTrustManagers())if(candidate instanceof X509TrustManager)tm=(X509TrustManager)candidate;
      X509TrustManagerExtensions ext=new X509TrustManagerExtensions(tm);
      ext.checkServerTrusted(chain,chain[0].getPublicKey().getAlgorithm(),host);check("allowed host chain trusted",true);
      if(Build.VERSION.SDK_INT<26){boolean rejected=false;try{ext.checkServerTrusted(chain,chain[0].getPublicKey().getAlgorithm(),"unrelated.example");}catch(CertificateException e){rejected=true;}check("extra root not trusted for unrelated hosts",rejected);}
      socket.close();
      rejected("https://self-signed.badssl.com/","self-signed certificate rejected");
      rejected("https://expired.badssl.com/","expired certificate rejected");
      rejected("https://wrong.host.badssl.com/","mismatched endpoint rejected");
    } catch(Exception e){check("unexpected "+causes(e)+" "+e.getMessage(),false);}
    Bundle result=new Bundle();result.putString("stream","\nAPI "+Build.VERSION.SDK_INT+"\n"+String.join("\n",checks)+"\nfailures="+failures+"\n");finish(failures==0?-1:0,result);
  }
}
