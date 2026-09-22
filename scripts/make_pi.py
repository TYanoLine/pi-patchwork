from decimal import Decimal, getcontext
import sys
n=int(sys.argv[1]); getcontext().prec=n+30
C=426880*Decimal(10005).sqrt(); M=1; L=13591409; X=1; K=6; S=Decimal(L)
for i in range(1, n//14+3):
    M=(M*(K**3-16*K))//(i**3); L+=545140134; X*=-262537412640768000; S+=Decimal(M*L)/X; K+=12
s=str(C/S).replace('.','')
open(sys.argv[2],'w').write(s[1:n+1]+'\n')
