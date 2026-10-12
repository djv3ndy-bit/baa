#!/usr/bin/env python3
"""Local deterministic packaging only; no database/network execution."""
from pathlib import Path
import hashlib,json,re
ROOT=Path(__file__).resolve().parent
EXPECTED='c2101c477ed064daebec4ba2a4ea39a00ab3459c6801c87f97b3e13696439716'
INNER='$baristamatch_reviewed_inner_c2101c$'
OUTER='$baristamatch_mcp_atomic_c2101c$'

def top_level_statements(sql):
    # Skip PostgreSQL strings, identifiers, dollar bodies, and nested comments;
    # retain unquoted statement tokens to distinguish transaction control from
    # PL/pgSQL BEGIN/END inside the original DO/function bodies.
    out=[];i=0
    while i<len(sql):
        if sql.startswith('--',i):
            end=sql.find('\n',i+2);i=len(sql) if end<0 else end;out.append(' ')
        elif sql.startswith('/*',i):
            depth=1;i+=2
            while depth and i<len(sql):
                if sql.startswith('/*',i):depth+=1;i+=2
                elif sql.startswith('*/',i):depth-=1;i+=2
                else:i+=1
            if depth:raise ValueError('UNTERMINATED_COMMENT')
            out.append(' ')
        elif sql[i] in "'\"":
            quote=sql[i];i+=1
            while i<len(sql):
                if sql[i]==quote:
                    if i+1<len(sql) and sql[i+1]==quote:i+=2;continue
                    i+=1;break
                i+=1
            else:raise ValueError('UNTERMINATED_QUOTE')
            out.append(' quoted_body ')
        elif sql[i]=='$' and (tag:=re.match(r'\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$',sql[i:])):
            delimiter=tag.group();end=sql.find(delimiter,i+len(delimiter))
            if end<0:raise ValueError('UNTERMINATED_DOLLAR_BODY')
            i=end+len(delimiter);out.append(' dollar_body ')
        else:out.append(sql[i]);i+=1
    return [re.sub(r'\s+',' ',s).strip() for s in ''.join(out).split(';') if s.strip()]

def build():
    source=(ROOT/'proposed-production-billing-fcm.sql').read_text()
    assert hashlib.sha256(source.encode()).hexdigest()==EXPECTED,'REVIEWED_SOURCE_CHANGED'
    statements=top_level_statements(source)
    assert statements[0].lower()=='begin' and statements[-1].lower()=='commit'
    assert sum(s.lower() in ('begin','commit') for s in statements)==2
    assert len(re.findall(r'(?m)^begin;\n',source))==1
    assert len(re.findall(r'(?m)^commit;\s*$',source))==1
    # The verified original has exactly these two top-level transaction lines.
    # Preserve every other source byte, including all guards/postchecks/settings.
    body=re.sub(r'(?m)^begin;\n','',source,count=1)
    body=re.sub(r'(?m)^commit;\s*$','',body,count=1)
    assert not any(re.match(r'(?i)^(begin|commit|rollback|start transaction|end|savepoint|release|prepare transaction)\b',s) for s in top_level_statements(body))
    assert INNER not in body and OUTER not in body
    payload=(
      '-- LOCAL MCP REVIEW PAYLOAD ONLY. No hosted application authorized.\n'
      '-- One DO statement; no transaction control. All inner exceptions propagate.\n'
      '-- The inner statement_timeout setting is NOT a proven outer DO deadline.\n'
      f'DO {OUTER}\nBEGIN\n  EXECUTE {INNER}\n{body}{INNER};\nEND;\n{OUTER} LANGUAGE plpgsql;\n'
    )
    assert len(top_level_statements(payload))==1
    assert top_level_statements(payload)[0].startswith('DO ')
    dest=ROOT/'proposed-production-billing-fcm-mcp.sql';dest.write_text(payload)
    info={'scope':'LOCAL MCP PACKAGING ONLY; NOT HOSTED EXECUTION',
      'standaloneSourceSha256':EXPECTED,'mcpPayloadSha256':hashlib.sha256(payload.encode()).hexdigest(),
      'topLevelStatements':1,'topLevelTransactionControl':False,
      'transformation':'Only top-level BEGIN/COMMIT removed; every other original source byte preserved inside uniquely dollar-quoted EXECUTE.',
      'timeouts':'lock_timeout remains3s; inner statement_timeout20s is not claimed to bound the already running outer DO/Management API operation.'}
    (ROOT/'mcp-payload-manifest.json').write_text(json.dumps(info,indent=2)+'\n')
    print(json.dumps(info))

if __name__=='__main__':build()
