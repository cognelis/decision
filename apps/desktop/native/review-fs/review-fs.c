#define _DARWIN_C_SOURCE
#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <node_api.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <dirent.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <signal.h>
#ifdef __APPLE__
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <dlfcn.h>
#include <libproc.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#endif

static napi_value fail(napi_env env) {
  const char *code = errno == ELOOP ? "ELOOP" : errno == ENOTDIR ? "ENOTDIR" : errno == ENOENT ? "ENOENT" : errno == EEXIST ? "EEXIST" : errno == EPERM ? "EPERM" : "EIO";
  napi_throw_error(env, code, strerror(errno)); return NULL;
}
static int args(napi_env env, napi_callback_info info, size_t count, napi_value *values) {
  size_t argc = count; if (napi_get_cb_info(env, info, &argc, values, NULL, NULL) != napi_ok || argc != count) { napi_throw_type_error(env, NULL, "Invalid native filesystem arguments"); return 0; } return 1;
}
static char *name(napi_env env, napi_value value) {
  size_t size; if (napi_get_value_string_utf8(env, value, NULL, 0, &size) != napi_ok || !size || size > 4096) { napi_throw_type_error(env, NULL, "Invalid entry name"); return NULL; }
  char *text = malloc(size + 1); if (!text) { napi_throw_error(env, NULL, "Allocation failed"); return NULL; }
  napi_get_value_string_utf8(env, value, text, size + 1, &size);
  if (strchr(text, '/') || !strcmp(text,"..") || strlen(text) != size) { free(text); napi_throw_type_error(env, NULL, "Only one relative entry is accepted"); return NULL; } return text;
}
static napi_value open_at(napi_env env, napi_callback_info info) {
  napi_value values[4], result; if (!args(env, info, 4, values)) return NULL;
  int32_t fd, flags, mode; if (napi_get_value_int32(env,values[0],&fd) || napi_get_value_int32(env,values[2],&flags) || napi_get_value_int32(env,values[3],&mode)) { napi_throw_type_error(env,NULL,"Invalid descriptor/flags"); return NULL; }
  char *entry = name(env,values[1]); if (!entry) return NULL;
  int opened = openat(fd,entry,flags | O_NOFOLLOW | O_CLOEXEC,mode); free(entry); if (opened < 0) return fail(env);
  napi_create_int32(env,opened,&result); return result;
}
static napi_value mkdir_at(napi_env env,napi_callback_info info) {
  napi_value values[2],result; if (!args(env,info,2,values)) return NULL;
  int32_t fd; if (napi_get_value_int32(env,values[0],&fd)) { napi_throw_type_error(env,NULL,"Invalid descriptor"); return NULL; }
  char *entry = name(env,values[1]); if (!entry) return NULL;
  int status = mkdirat(fd,entry,0700); free(entry); if (status < 0 && errno != EEXIST) return fail(env);
  napi_get_undefined(env,&result); return result;
}
static napi_value unlink_at(napi_env env,napi_callback_info info) {
  napi_value values[2],result; if (!args(env,info,2,values)) return NULL;
  int32_t fd; if (napi_get_value_int32(env,values[0],&fd)) { napi_throw_type_error(env,NULL,"Invalid descriptor"); return NULL; }
  char *entry=name(env,values[1]);if(!entry)return NULL;
  int status=unlinkat(fd,entry,0);free(entry);if(status<0)return fail(env);
  napi_get_undefined(env,&result);return result;
}
static napi_value entries(napi_env env,napi_callback_info info) {
  napi_value values[1],result; if(!args(env,info,1,values))return NULL;
  int32_t fd;if(napi_get_value_int32(env,values[0],&fd)){napi_throw_type_error(env,NULL,"Invalid descriptor");return NULL;}
  int copied=dup(fd);if(copied<0)return fail(env);DIR *dir=fdopendir(copied);if(!dir){close(copied);return fail(env);}
  rewinddir(dir);napi_create_array(env,&result);struct dirent *item;uint32_t at=0;
  while((item=readdir(dir))){if(!strcmp(item->d_name,".")||!strcmp(item->d_name,".."))continue;if(at>=10000){closedir(dir);napi_throw_error(env,NULL,"Directory exceeds 10000 entries");return NULL;}napi_value text;napi_create_string_utf8(env,item->d_name,NAPI_AUTO_LENGTH,&text);napi_set_element(env,result,at++,text);}
  closedir(dir);return result;
}
static napi_value mach_lookup(napi_env env,napi_callback_info info) {
  napi_value values[1],result; if(!args(env,info,1,values))return NULL;
  char *service=name(env,values[0]);if(!service)return NULL;int status=-1;
#ifdef __APPLE__
  mach_port_t port=MACH_PORT_NULL;status=bootstrap_look_up(bootstrap_port,service,&port);
  if(port!=MACH_PORT_NULL)mach_port_deallocate(mach_task_self(),port);
#endif
  free(service);napi_create_int32(env,status,&result);return result;
}

/* Private SPI is dynamically resolved and positively tested by the installer.
 * SANDBOX_FILTER_GLOBAL_NAME=2 is the Darwin SandboxSPI.h enum value.
 * Names are CSPRNG secrets, never registered and never passed to the child. */
#define INSTALL_FINGERPRINT_BITS 32
struct install_fingerprint { char names[INSTALL_FINGERPRINT_BITS][65]; int allowed[INSTALL_FINGERPRINT_BITS]; };
static int fingerprint_args(napi_env env,napi_value names,napi_value allowed,struct install_fingerprint *fingerprint) {
  bool a=false,b=false;uint32_t n=0,m=0;int ones=0;
  if(napi_is_array(env,names,&a)||napi_is_array(env,allowed,&b)||!a||!b||napi_get_array_length(env,names,&n)||napi_get_array_length(env,allowed,&m)||n!=32||m!=32)goto invalid;
  for(uint32_t i=0;i<32;i++){
    napi_value name,bit;size_t size=0;bool permitted;
    if(napi_get_element(env,names,i,&name)||napi_get_element(env,allowed,i,&bit)||napi_get_value_string_utf8(env,name,NULL,0,&size)||size!=64||napi_get_value_bool(env,bit,&permitted))goto invalid;
    if(napi_get_value_string_utf8(env,name,fingerprint->names[i],65,&size)||size!=64)goto invalid;
    for(int j=0;j<64;j++)if(!((fingerprint->names[i][j]>='0'&&fingerprint->names[i][j]<='9')||(fingerprint->names[i][j]>='a'&&fingerprint->names[i][j]<='f')))goto invalid;
    for(uint32_t j=0;j<i;j++)if(!strcmp(fingerprint->names[i],fingerprint->names[j]))goto invalid;
    fingerprint->allowed[i]=permitted;ones+=permitted;
  }
  if(ones<8||ones>24)goto invalid;return 1;
invalid:napi_throw_type_error(env,NULL,"Invalid secret sandbox fingerprint");return 0;
}
#ifdef __APPLE__
typedef int (*sandbox_check_fn)(pid_t,const char *,int,...);
static sandbox_check_fn install_check;
static const int *install_quiet;
static int load_sandbox_check(void) {
  if(install_check && install_quiet)return 1;
  void *library=dlopen("/usr/lib/system/libsystem_sandbox.dylib",RTLD_NOW|RTLD_LOCAL);
  if(!library){errno=ENOSYS;return 0;}
  install_check=(sandbox_check_fn)dlsym(library,"sandbox_check");
  install_quiet=(const int *)dlsym(library,"SANDBOX_CHECK_NO_REPORT");
  if(!install_check||!install_quiet){errno=ENOSYS;return 0;}return 1;
}
static int same_process(const struct proc_bsdinfo *a,const struct proc_bsdinfo *b) {
  return a->pbi_pid==b->pbi_pid && a->pbi_uid==b->pbi_uid && a->pbi_start_tvsec==b->pbi_start_tvsec && a->pbi_start_tvusec==b->pbi_start_tvusec;
}
/* Unknown queries never grant membership. -1 also prevents a false "empty"
 * snapshot from authorizing publication when inspection itself failed. */
static int owned_process(pid_t pid,const struct install_fingerprint *fingerprint,struct proc_bsdinfo *info) {
  if(pid==getpid())return 0;
  int sandboxed=install_check(pid,NULL,0);
  if(sandboxed==0)return 0;
  if(sandboxed!=1){if(kill(pid,0)<0&&errno==ESRCH)return 0;errno=EIO;return -1;}
  for(int i=0;i<32;i++){
    int value=install_check(pid,"mach-lookup",2|*install_quiet,fingerprint->names[i]);
    if(value!=0&&value!=1){if(kill(pid,0)<0&&errno==ESRCH)return 0;errno=EIO;return -1;}
    if(value!=(fingerprint->allowed[i]?0:1))return 0;
  }
  /* Only full matches may require BSD identity data. Unrelated protected
   * processes are excluded without assuming they are inspectable. */
  if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,info,sizeof(*info))!=(int)sizeof(*info)) {
    if(kill(pid,0)<0&&errno==ESRCH)return 0;errno=EIO;return -1;
  }
  if(info->pbi_uid!=getuid()||info->pbi_status==SZOMB)return 0;
  struct proc_bsdinfo after;
  if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&after,sizeof(after))!=(int)sizeof(after)) {
    if(kill(pid,0)<0&&errno==ESRCH)return 0;errno=EIO;return -1;
  }
  return same_process(info,&after);
}
#endif
static napi_value sandbox_processes(napi_env env,napi_callback_info info) {
  napi_value values[2],result;if(!args(env,info,2,values))return NULL;
  struct install_fingerprint fingerprint;if(!fingerprint_args(env,values[0],values[1],&fingerprint))return NULL;
#ifdef __APPLE__
  if(!load_sandbox_check())return fail(env);
  /* ponytail: at most 131072 user PIDs per snapshot; require a full snapshot. */
  int capacity=4096,count=0;pid_t *pids=NULL;
  for(;;){free(pids);pids=calloc(capacity,sizeof(pid_t));if(!pids){napi_throw_error(env,NULL,"Allocation failed");return NULL;}
    int bytes=proc_listpids(PROC_UID_ONLY,getuid(),pids,capacity*(int)sizeof(pid_t));
    if(bytes<=0){free(pids);errno=EIO;return fail(env);}
    count=bytes/(int)sizeof(pid_t);if(count<capacity)break;
    if(capacity>=131072){free(pids);errno=EOVERFLOW;return fail(env);}capacity*=2;
  }
  napi_create_array(env,&result);uint32_t at=0;
  for(int i=0;i<count;i++){if(pids[i]<=0)continue;struct proc_bsdinfo process;
    int owned=owned_process(pids[i],&fingerprint,&process);
    if(owned<0){free(pids);return fail(env);}if(!owned)continue;
    napi_value record,value;napi_create_object(env,&record);napi_create_int32(env,pids[i],&value);napi_set_named_property(env,record,"pid",value);
    napi_create_double(env,(double)process.pbi_start_tvsec,&value);napi_set_named_property(env,record,"seconds",value);
    napi_create_double(env,(double)process.pbi_start_tvusec,&value);napi_set_named_property(env,record,"microseconds",value);napi_set_element(env,result,at++,record);
  }
  free(pids);return result;
#else
  errno=ENOSYS;return fail(env);
#endif
}
static napi_value kill_sandbox_process(napi_env env,napi_callback_info info) {
  napi_value values[5],result;if(!args(env,info,5,values))return NULL;
  int32_t pid;double seconds,microseconds;
  if(napi_get_value_int32(env,values[0],&pid)||napi_get_value_double(env,values[1],&seconds)||napi_get_value_double(env,values[2],&microseconds)||pid<=1||seconds<0||seconds>9007199254740991.0||microseconds<0||microseconds>999999){napi_throw_type_error(env,NULL,"Invalid process identity");return NULL;}
  struct install_fingerprint fingerprint;if(!fingerprint_args(env,values[3],values[4],&fingerprint))return NULL;
#ifdef __APPLE__
  if(!load_sandbox_check())return fail(env);struct proc_bsdinfo process,last;
  int owned=owned_process(pid,&fingerprint,&process);if(owned<0)return fail(env);
  if(!owned||(double)process.pbi_start_tvsec!=seconds||(double)process.pbi_start_tvusec!=microseconds){napi_get_boolean(env,0,&result);return result;}
  /* Recheck all 32 bits and the birth identity immediately before signalling. */
  owned=owned_process(pid,&fingerprint,&last);if(owned<0)return fail(env);
  if(!owned||!same_process(&process,&last)){napi_get_boolean(env,0,&result);return result;}
  /* ponytail: PID identity checks and kill are not atomic on macOS. A PID reuse
   * window remains after this last check; do not claim zero reuse risk. */
  if(kill(pid,SIGKILL)<0){if(errno==ESRCH){napi_get_boolean(env,0,&result);return result;}return fail(env);}
  napi_get_boolean(env,1,&result);return result;
#else
  errno=ENOSYS;return fail(env);
#endif
}
static napi_value init(napi_env env,napi_value exports) {
  napi_property_descriptor methods[]={{"openAt",NULL,open_at,NULL,NULL,NULL,napi_default,NULL},{"mkdirAt",NULL,mkdir_at,NULL,NULL,NULL,napi_default,NULL},{"unlinkAt",NULL,unlink_at,NULL,NULL,NULL,napi_default,NULL},{"entries",NULL,entries,NULL,NULL,NULL,napi_default,NULL},{"machLookup",NULL,mach_lookup,NULL,NULL,NULL,napi_default,NULL},{"sandboxProcesses",NULL,sandbox_processes,NULL,NULL,NULL,napi_default,NULL},{"killSandboxProcess",NULL,kill_sandbox_process,NULL,NULL,NULL,napi_default,NULL}};
  napi_define_properties(env,exports,7,methods);return exports;
}
NAPI_MODULE(review_fs,init)
